// Spec sàn của sản phẩm cha: đọc, lưu, giá trị gửi lên sàn (#400, Documents/21 §18.5). Một bộ mỗi sàn, mọi gian hàng của
// sàn dùng chung. `PUT` gọi sàn lấy attribute leaf khi thiếu/cũ (A16) ngoài giao dịch, rồi kiểm và ghi trong `withCompany`.
import { recordAudit, responsibleOrgOf } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import type { ModuleContext } from '../../../../shared/module.ts';
import {
  countryOption,
  CUSTOM_AXIS,
  type FieldSource,
  type MissingItem,
  nextFieldSources,
  type PlatformAttribute,
  resolveOption,
  type SpecAttributeValue,
  specMissing,
} from '../domain/product-spec.ts';
import { findCategory, leafAttributesOf } from '../repository/platform-categories.ts';
import {
  findSpec,
  insertSpec,
  permissionsOf,
  type ProductSpecRow,
  specsOf,
  updateSpec,
} from '../repository/product-specs.ts';
import type { Marketplace } from '../repository/schema.ts';
import { findShopRow } from '../repository/shops.ts';
import type { MarketplaceAdapter, Responsible } from './marketplaces/index.ts';
import { ensureLeaf } from './platform-categories.ts';
import type { SpecCheck } from './push-block.ts';
import { type ListingVariant, productPort } from './product-port.ts';
import { platformOf } from './shops.ts';

export interface ProductSpec {
  productId: string;
  platform: Marketplace;
  externalCategoryId: string;
  categoryPath: string | null;
  categoryStatus: ProductSpecRow['categoryStatus'];
  attributes: Record<string, SpecAttributeValue>;
  axisMap: Record<string, string>;
  valueMap: Record<string, string>;
  source: ProductSpecRow['source'];
  /** Nguồn từng attribute trong `attributes` (#497). */
  fieldSources: Record<string, FieldSource>;
  version: number;
  updatedAt: Date;
}

/** Bản sàn đang ghi ở lần đọc gần nhất khi ghép SKU (#497, Documents/21 §18.5). `shopId` null khi gian hàng đã xoá. */
export interface RemoteSpec {
  shopId: string | null;
  shopName: string | null;
  readAt: Date;
  originCountry: string | null;
  brand: string | null;
  description: string | null;
  sizeChartUrl: string | null;
  imageUrls: string[];
  variants: { variantId: string; weightG: number | null; lengthMm: number | null; widthMm: number | null; heightMm: number | null }[];
}

export interface SpecView {
  spec: ProductSpec | null;
  missing: MissingItem[];
  remote: RemoteSpec | null;
}

/** Dữ liệu sản phẩm cần cho spec: trục phân loại, giá trị trục, xuất xứ, thương hiệu. */
export interface SpecProduct {
  axes: { attributeId: string; name: string }[];
  valueIds: Map<string, string>; // attributeValueId → attributeId
  originCountry: string | null;
  brand: string | null;
}

export function specProductOf(variants: readonly ListingVariant[]): SpecProduct {
  const axes = new Map<string, string>();
  const valueIds = new Map<string, string>();
  for (const v of variants) {
    for (const a of v.attributes) {
      axes.set(a.attributeId, a.attributeName);
      valueIds.set(a.valueId, a.attributeId);
    }
  }
  const first = variants[0];
  return {
    axes: [...axes].map(([attributeId, name]) => ({ attributeId, name })),
    valueIds,
    originCountry: first?.originCountry ?? null,
    brand: first?.brand ?? null,
  };
}

const notFound = () => new AppError(404, 'not_found', 'Không tìm thấy sản phẩm');

const optionsWithEn = (a: PlatformAttribute) => {
  const raw = Array.isArray(a.raw['options']) ? (a.raw['options'] as { id?: unknown; en_name?: unknown }[]) : [];
  const en = new Map(raw.map((o) => [String(o.id), typeof o.en_name === 'string' ? o.en_name : null]));
  return a.options.map((o) => ({ ...o, enLabel: en.get(o.id) ?? null }));
};

/**
 * Giá trị lúc đẩy tự điền khi spec không có (A1, #292): hồ sơ công ty (`tier = 'company'`), xuất xứ đổi từ ISO sang lựa chọn
 * sàn (không khớp thì không đoán: vắng), thương hiệu của catalog, trống thì thương hiệu mặc định của sàn.
 */
export function specFallbacks(
  adapter: Pick<MarketplaceAdapter, 'responsibleFields' | 'productFields' | 'defaultBrand'>,
  attributes: readonly PlatformAttribute[] | null,
  product: Pick<SpecProduct, 'originCountry' | 'brand'>,
  org: Responsible | null,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [code, field] of Object.entries(adapter.responsibleFields ?? {})) out[code] = org?.[field] || null;
  for (const [code, field] of Object.entries(adapter.productFields ?? {})) {
    if (field === 'brand') out[code] = product.brand || adapter.defaultBrand || null;
    else {
      const attr = attributes?.find((a) => a.code === code);
      out[code] = attr && product.originCountry ? countryOption(product.originCountry, optionsWithEn(attr)) : null;
    }
  }
  return out;
}

/** Nhãn của một giá trị đã lưu (mã lựa chọn hoặc nhãn cũ); không khớp lựa chọn thì giữ nguyên chuỗi (tự nhập). */
function labelOf(attr: PlatformAttribute | undefined, value: string): string {
  if (!attr) return value;
  const id = resolveOption(attr, value);
  return id === null ? value : (attr.options.find((o) => o.id === id)?.label ?? value);
}

/**
 * Giá trị gửi lên sàn theo mã attribute (AC-13, AC-15): spec (`tier = 'category'`, giá trị người dùng nhập ở `company`), rồi
 * xuất xứ, thương hiệu của catalog (A1; spec chép từ ghép danh mục còn khoá xuất xứ thì dùng khi catalog không đổi được, luật
 * chuyển tiếp AC-15). Select đổi sang nhãn của sàn (adapter tự đổi nhãn sang mã nếu sàn cần). Hồ sơ công ty adapter tự điền
 * (`NewProduct.responsible`).
 */
export function pushAttributes(
  adapter: Pick<MarketplaceAdapter, 'productFields' | 'defaultBrand'>,
  attributes: readonly PlatformAttribute[] | null,
  spec: Pick<ProductSpecRow, 'attributes'>,
  product: Pick<SpecProduct, 'originCountry' | 'brand'>,
): Record<string, string | string[]> {
  const byCode = new Map((attributes ?? []).map((a) => [a.code, a]));
  const out: Record<string, string | string[]> = {};
  for (const [code, value] of Object.entries(spec.attributes)) {
    const attr = byCode.get(code);
    out[code] = Array.isArray(value) ? value.map((v) => labelOf(attr, v)) : labelOf(attr, value);
  }
  const fallbacks = specFallbacks({ ...adapter, responsibleFields: {} }, attributes, product, null);
  for (const [code, field] of Object.entries(adapter.productFields ?? {})) {
    const attr = byCode.get(code);
    const fromCatalog = fallbacks[code];
    if (field === 'brand') {
      // Catalog có thương hiệu thì thắng; trống thì giữ giá trị cũ của spec chép, không có nữa thì để adapter tự điền mặc định.
      if (product.brand) out[code] = product.brand;
    } else if (fromCatalog) out[code] = labelOf(attr, fromCatalog);
    // Catalog trống hoặc mã không đổi được: giữ khoá cũ của spec chép (nếu có), không gửi giá trị đoán.
  }
  return out;
}

const toSpec = (r: ProductSpecRow, categoryPath: string | null): ProductSpec => ({
  productId: r.productId,
  platform: r.platform,
  externalCategoryId: r.externalCategoryId,
  categoryPath,
  categoryStatus: r.categoryStatus,
  attributes: r.attributes,
  axisMap: r.axisMap,
  valueMap: r.valueMap,
  source: r.source,
  fieldSources: r.fieldSources,
  version: r.version,
  updatedAt: r.updatedAt,
});

/** Phần còn thiếu của một spec theo attribute đã có trong bảng (chưa lấy thì chỉ xét category, trục). Gọi trong `withCompany`. */
export async function missingOf(
  adapter: MarketplaceAdapter,
  row: ProductSpecRow,
  product: SpecProduct,
  org: Responsible | null,
): Promise<{ missing: MissingItem[]; attributes: PlatformAttribute[] | null }> {
  const category = await findCategory(row.platform, row.externalCategoryId);
  const attributes = category?.attributesFetchedAt ? await leafAttributesOf(row.platform, row.externalCategoryId) : null;
  const missing = specMissing({
    spec: row,
    attributes,
    axes: product.axes,
    fallbacks: specFallbacks(adapter, attributes, product, org),
  });
  return { missing, attributes };
}

/** Spec kèm `missing` như route `GET` trả (cũng là `current` của 409 `version_conflict`). Gọi trong `withCompany`. */
export async function specView(companyId: string, adapter: MarketplaceAdapter, row: ProductSpecRow | undefined, product: SpecProduct): Promise<SpecView> {
  if (!row) return { spec: null, missing: [], remote: null };
  const org = adapter.responsibleFields ? await responsibleOrgOf(companyId) : null;
  const { missing } = await missingOf(adapter, row, product, org);
  const category = await findCategory(row.platform, row.externalCategoryId);
  return { spec: toSpec(row, category && category.syncedAt ? category.path : null), missing, remote: await remoteOf(row) };
}

/** `remote` của spec: tên gian hàng hiện tại, gian hàng đã xoá thì tên lúc đọc. */
async function remoteOf(row: ProductSpecRow): Promise<RemoteSpec | null> {
  if (!row.remoteFacts || !row.remoteReadAt) return null;
  const { shopName, ...facts } = row.remoteFacts;
  const shop = row.remoteShopId ? await findShopRow(row.remoteShopId) : undefined;
  return { shopId: shop?.id ?? null, shopName: shop?.shopName ?? shopName, readAt: row.remoteReadAt, ...facts };
}

/** Mọi biến thể của sản phẩm, kể cả biến thể lưu trữ (cùng tập với bảng listing và request đẩy, review BE2 P2-6). */
async function variantsOf(ctx: ModuleContext, productId: string): Promise<ListingVariant[]> {
  const variants = await productPort(ctx).variants(undefined, { productIds: [productId] });
  if (!variants.length) throw notFound();
  return variants;
}

async function productOf(ctx: ModuleContext, productId: string): Promise<SpecProduct> {
  return specProductOf(await variantsOf(ctx, productId));
}

/** Đọc spec của sản phẩm trên sàn; chưa có thì `spec: null`. */
export async function getProductSpec(ctx: ModuleContext, companyId: string, productId: string, raw: string): Promise<SpecView> {
  const { platform, adapter } = platformOf(raw);
  return withCompany(companyId, async () => {
    const variants = await variantsOf(ctx, productId);
    const row = await findSpec(productId, platform);
    return specView(companyId, adapter, row, specProductOf(variants));
  });
}

export interface SpecInput {
  externalCategoryId: string;
  attributes: Record<string, SpecAttributeValue>;
  axisMap: Record<string, string>;
  valueMap: Record<string, string>;
  version: number | null;
}

/** `path` của GetNextCascadeProp: cặp `propId:valueId` nối bằng `,` hoặc `;` (vd `120013644:162,100006867:160387`). */
const CASCADE_PATH = /^\d+:\d+(?:[,;]\d+:\d+)*$/;

const hasValue = (v: SpecAttributeValue | undefined) =>
  Array.isArray(v) ? v.some((x) => x.trim() !== '') : typeof v === 'string' && v.trim() !== '';

/**
 * Kiểm và chuẩn hoá spec theo attribute của leaf (AC-6, AC-7). Chỉ giữ `tier = 'category'`; `company` gửi trống hay trùng mặc
 * định thì bỏ (#292); `product` bỏ (catalog giữ). Select lưu mã lựa chọn. Trả lỗi theo ô.
 */
export function normalizeSpec(
  input: SpecInput,
  attributes: readonly PlatformAttribute[],
  product: SpecProduct,
  defaults: Record<string, string | null>,
): { values: Pick<SpecInput, 'attributes' | 'axisMap' | 'valueMap'>; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const out: Record<string, SpecAttributeValue> = {};
  const byCode = new Map(attributes.map((a) => [a.code, a]));
  for (const a of attributes) {
    if (a.kind === 'sales' || a.tier === 'product') continue;
    const value = input.attributes[a.code];
    const key = `attributes.${a.code}`;
    if (a.tier === 'company') {
      const one = Array.isArray(value) ? value.join(',') : value?.trim();
      if (one && one !== defaults[a.code]) out[a.code] = one;
      else if (!defaults[a.code] && a.required) errors[key] = `Nhập ${a.label}`;
      continue;
    }
    if (!hasValue(value)) continue;
    const list = (Array.isArray(value) ? value : [value!]).map((v) => v.trim()).filter((v) => v !== '');
    // Cascade (Lazada propCascade, §18.5): lưu nguyên `path` tới cấp `leaf = true` (route `cascade`), một chuỗi các cặp
    // `propId:valueId` nối bằng `,`/`;` như GetNextCascadeProp; bắt buộc xét như attribute khác (`specMissing`).
    if (a.input === 'cascade') {
      if (Array.isArray(value) || !CASCADE_PATH.test(list[0]!)) errors[key] = `${a.label}: chọn đủ các cấp tới cấp cuối`;
      else out[a.code] = list[0]!;
      continue;
    }
    if (a.input !== 'select' && a.input !== 'multiselect') {
      out[a.code] = list.join(',');
      continue;
    }
    const ids: string[] = [];
    for (const v of list) {
      const id = resolveOption(a, v);
      if (id !== null) ids.push(id);
      else if (a.allowCustom) ids.push(v);
      else errors[key] = `${a.label} không có trong lựa chọn của sàn`;
    }
    out[a.code] = a.input === 'multiselect' ? ids : ids[0]!;
  }
  // Bắt buộc, bắt buộc theo điều kiện (sales không tính, chỉ kiểm qua trục). `tier = 'product'` (xuất xứ) không báo theo ô: ô ở
  // tab spec chỉ đọc, điền ở trang sản phẩm; `missing` báo và chặn đẩy (review BE2 P2-7).
  for (const m of specMissing({ spec: { attributes: out, axisMap: {}, categoryStatus: 'ok' }, attributes, axes: [], fallbacks: defaults })) {
    if (byCode.get(m.code)?.tier === 'product') continue;
    if (m.reason === 'required' || m.reason === 'required_when') errors[`attributes.${m.code}`] ??= `Nhập ${m.label}`;
  }
  const sales = new Set(attributes.filter((a) => a.kind === 'sales').map((a) => a.code));
  const axisMap: Record<string, string> = {};
  for (const axis of product.axes) {
    const target = input.axisMap[axis.attributeId];
    if (target == null || (target !== CUSTOM_AXIS && !sales.has(target))) {
      errors[`axisMap.${axis.attributeId}`] = `Chọn thuộc tính phân loại của sàn cho ${axis.name}`;
    } else axisMap[axis.attributeId] = target;
  }
  for (const key of Object.keys(input.axisMap)) {
    if (!product.axes.some((a) => a.attributeId === key)) errors[`axisMap.${key}`] = 'Không phải trục phân loại của sản phẩm';
  }
  const valueMap: Record<string, string> = {};
  for (const [valueId, optionId] of Object.entries(input.valueMap)) {
    const axisId = product.valueIds.get(valueId);
    const target = axisId ? axisMap[axisId] : undefined;
    const attr = target && target !== CUSTOM_AXIS ? byCode.get(target) : undefined;
    if (!attr || !attr.options.some((o) => o.id === optionId)) {
      errors[`valueMap.${valueId}`] = 'Giá trị không có trong lựa chọn của thuộc tính phân loại đã chọn';
    } else valueMap[valueId] = optionId;
  }
  return { values: { attributes: out, axisMap, valueMap }, errors };
}

/**
 * Lưu spec (AC-6, AC-7, AC-10, AC-S4). Lấy attribute leaf trước (A16, ngoài giao dịch): TikTok mượn gian hàng `active` đầu
 * tiên; sàn lỗi mà còn bản cũ thì kiểm theo bản cũ. Leaf không `active` hoặc không phải lá: 422 `errors.externalCategoryId`.
 */
export async function putProductSpec(
  ctx: ModuleContext,
  actor: { companyId: string; accountId: string },
  productId: string,
  raw: string,
  input: SpecInput,
): Promise<SpecView> {
  const { platform, adapter } = platformOf(raw);
  const { companyId } = actor;
  const product = await withCompany(companyId, () => productOf(ctx, productId));
  const badCategory = () =>
    new AppError(422, 'validation_failed', 'Dữ liệu không hợp lệ', {
      errors: { externalCategoryId: 'Category không phải category lá đang dùng được của sàn' },
    });
  try {
    await ensureLeaf(companyId, platform, adapter, input.externalCategoryId);
  } catch (err) {
    if (err instanceof AppError && (err.code === 'category_not_leaf' || err.code === 'marketplace_rejected')) throw badCategory();
    throw err;
  }
  const category = await findCategory(platform, input.externalCategoryId);
  if (!category || !category.isLeaf || category.status !== 'active') throw badCategory();
  const attributes = await leafAttributesOf(platform, input.externalCategoryId);
  return withCompany(companyId, async () => {
    const org = adapter.responsibleFields ? await responsibleOrgOf(companyId) : null;
    const defaults = specFallbacks(adapter, attributes, product, org);
    const { values, errors } = normalizeSpec(input, attributes, product, defaults);
    if (Object.keys(errors).length) throw new AppError(422, 'validation_failed', 'Dữ liệu không hợp lệ', { errors });
    const before = await findSpec(productId, platform);
    const conflict = async () => {
      const current = await findSpec(productId, platform);
      return new AppError(409, 'version_conflict', 'Thông tin sàn của sản phẩm vừa được người khác sửa', {
        current: current ? (await specView(companyId, adapter, current, product)).spec : null,
      });
    };
    let row: ProductSpecRow | undefined;
    const patch = { externalCategoryId: input.externalCategoryId, ...values, fieldSources: nextFieldSources(before, values.attributes) };
    if (input.version === null) {
      if (before) throw await conflict();
      row = await insertSpec({ ...patch, companyId, productId, platform, source: 'push', version: 1 });
    } else {
      row = await updateSpec(productId, platform, input.version, { ...patch, source: 'push', categoryStatus: 'ok' });
    }
    if (!row) throw await conflict();
    const variants = await productPort(ctx).variants(undefined, { productIds: [productId] });
    await recordAudit({
      companyId,
      actorId: actor.accountId,
      action: before ? 'update' : 'create',
      entityType: 'channel.product_specs',
      entityId: row.id,
      label: `${variants[0]?.productName ?? productId} · ${platform}`,
      before: before ? { externalCategoryId: before.externalCategoryId, attributes: before.attributes, version: before.version } : null,
      after: { externalCategoryId: row.externalCategoryId, attributes: row.attributes, version: row.version },
    });
    return specView(companyId, adapter, row, product);
  });
}

/** Spec kèm attribute leaf đã đọc, để việc nền dựng `NewProduct` mà không đọc lại. */
export interface SpecCheckFull extends SpecCheck {
  row: ProductSpecRow;
  attributes: PlatformAttribute[] | null;
  product: SpecProduct;
}

/**
 * Tình trạng spec của các sản phẩm với một gian hàng, theo lô (request đẩy, việc nền, bảng listing): `missing` theo attribute
 * đã có, quyền category đã ghi của gian hàng, luật bảng kích cỡ của category (`platform_categories`). Gọi trong `withCompany`. `variants`: mọi biến thể của các sản phẩm cần xét.
 */
export async function specChecks(
  shop: { id: string; companyId: string; platform: Marketplace },
  adapter: MarketplaceAdapter,
  variants: readonly ListingVariant[],
): Promise<Map<string, SpecCheckFull>> {
  const specs = await specsOf([...new Set(variants.map((v) => v.productId))], shop.platform);
  if (!specs.size) return new Map();
  const org = adapter.responsibleFields ? await responsibleOrgOf(shop.companyId) : null;
  const permissions = await permissionsOf(shop.id, [...specs.values()].map((s) => s.externalCategoryId));
  const byProduct = new Map<string, ListingVariant[]>();
  for (const v of variants) byProduct.set(v.productId, [...(byProduct.get(v.productId) ?? []), v]);
  // Mỗi category đọc một lần cho cả lô (bảng listing nhiều sản phẩm cùng category), không đọc theo từng sản phẩm.
  const leaves = new Map<string, Promise<{ category: Awaited<ReturnType<typeof findCategory>>; attributes: PlatformAttribute[] | null }>>();
  const leafOf = (id: string) => {
    let hit = leaves.get(id);
    if (!hit) {
      hit = (async () => {
        const category = await findCategory(shop.platform, id);
        return { category, attributes: category?.attributesFetchedAt ? await leafAttributesOf(shop.platform, id) : null };
      })();
      leaves.set(id, hit);
    }
    return hit;
  };
  const out = new Map<string, SpecCheckFull>();
  for (const [productId, row] of specs) {
    const vs = byProduct.get(productId) ?? [];
    const product = specProductOf(vs);
    const { category, attributes } = await leafOf(row.externalCategoryId);
    const missing = specMissing({ spec: row, attributes, axes: product.axes, fallbacks: specFallbacks(adapter, attributes, product, org) });
    out.set(productId, {
      externalCategoryId: row.externalCategoryId,
      missing,
      permission: permissions.get(row.externalCategoryId)?.status ?? null,
      sizeChartRule: category?.sizeChartRule ?? null,
      row,
      attributes,
      product,
    });
  }
  return out;
}

/** `specStatus` của dòng listing (§18.5): theo lô, không gọi sàn. */
export function specStatusOf(check: SpecCheck | undefined): 'complete' | 'incomplete' | 'missing' {
  if (!check) return 'missing';
  return check.missing.length ? 'incomplete' : 'complete';
}
