// Spec sàn của sản phẩm cha: đọc, lưu, giá trị gửi lên sàn (#400, Documents/21 §18.5). Một bộ mỗi sàn, mọi gian hàng của
// sàn dùng chung. `PUT` gọi sàn lấy attribute leaf khi thiếu/cũ (A16) ngoài giao dịch, rồi kiểm và ghi trong `withCompany`.
import { recordAudit, responsibleOrgOf } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import type { ModuleContext } from '../../../../shared/module.ts';
import { axisGroups, combineTarget, targetCombinable } from '../domain/axis-combine.ts';
import { type AxisInput, suggestAxes } from '../domain/axis-match.ts';
import {
  CUSTOM_AXIS,
  type FieldSource,
  type MissingItem,
  nextFieldSources,
  type PlatformAttribute,
  resolveOption,
  type SpecAttributeValue,
  specMissing,
  type VariantCapabilities,
} from '../domain/product-spec.ts';
import { type CatalogSpecValue, type ResolvedValue, resolvedValues, resolveSpecAttributes } from '../domain/spec-resolve.ts';
import { axisCodesOf } from '../repository/axis-mappings.ts';
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
import { mappingsOf } from '../repository/spec-mappings.ts';
import type { MarketplaceAdapter } from './marketplaces/index.ts';
import { ensureLeaf } from './platform-categories.ts';
import type { SpecCheck } from './push-block.ts';
import { type ListingVariant, type ProductPort, productPort } from './product-port.ts';
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
  /** Giá trị từng attribute sau khi áp ghi đè, thông số catalog, hồ sơ công ty, mặc định sàn (#509, Documents/21 §18.8.2). */
  resolved: Record<string, ResolvedValue>;
  missing: MissingItem[];
  remote: RemoteSpec | null;
  /** Gợi ý ghép trục cho leaf đang xét (`?categoryId` hoặc leaf của spec); null khi không có leaf hay chưa có attribute (#448). */
  suggestedAxisMap: Record<string, string> | null;
  suggestedValueMap: Record<string, string> | null;
  /** Khả năng khai biến thể của leaf đó kèm `combineTarget` (#568); null khi sàn không khai hoặc không có leaf (#448). */
  variantCapabilities: (VariantCapabilities & { combineTarget: string | null }) | null;
}

/** Dữ liệu sản phẩm cần cho spec: trục phân loại, giá trị trục, xuất xứ, thương hiệu. */
export interface SpecProduct {
  productId: string;
  axes: AxisInput[];
  valueIds: Map<string, string>; // attributeValueId → attributeId
  /** Giá trị trục của từng SKU (attributeId → nhãn), kiểm thuộc tính biến thể ghép (#568). */
  variantValues: Record<string, string>[];
  originCountry: string | null;
  brand: string | null;
}

export function specProductOf(variants: readonly ListingVariant[]): SpecProduct {
  const axes = new Map<string, AxisInput>();
  const valueIds = new Map<string, string>();
  for (const v of variants) {
    for (const a of v.attributes) {
      const axis = axes.get(a.attributeId) ?? { attributeId: a.attributeId, name: a.attributeName, platformKind: a.platformKind, values: [] };
      if (!axis.values.some((x) => x.valueId === a.valueId)) axis.values.push({ valueId: a.valueId, value: a.value });
      axes.set(a.attributeId, axis);
      valueIds.set(a.valueId, a.attributeId);
    }
  }
  const first = variants[0];
  return {
    productId: first?.productId ?? '',
    axes: [...axes.values()],
    valueIds,
    variantValues: variants.map((v) => Object.fromEntries(v.attributes.map((a) => [a.attributeId, a.value]))),
    originCountry: first?.originCountry ?? null,
    brand: first?.brand ?? null,
  };
}

const notFound = () => new AppError(404, 'not_found', 'Không tìm thấy sản phẩm');

/** Nhãn của một giá trị đã lưu (mã lựa chọn hoặc nhãn cũ); không khớp lựa chọn thì giữ nguyên chuỗi (tự nhập). */
function labelOf(attr: PlatformAttribute | undefined, value: string): string {
  if (!attr) return value;
  const id = resolveOption(attr, value);
  return id === null ? value : (attr.options.find((o) => o.id === id)?.label ?? value);
}

/**
 * Tính `resolved` cho một lô sản phẩm trên một sàn (#509): đọc thông số catalog, ánh xạ của công ty, hồ sơ công ty một lần.
 * Gọi trong `withCompany`.
 */
export type SpecResolver = (
  product: SpecProduct,
  attributes: readonly PlatformAttribute[] | null,
  overrides: Record<string, SpecAttributeValue>,
) => Record<string, ResolvedValue>;

export async function specResolver(
  port: Pick<ProductPort, 'productSpecs'>,
  companyId: string,
  adapter: MarketplaceAdapter,
  platform: Marketplace,
  productIds: readonly string[],
): Promise<SpecResolver> {
  const ids = [...new Set(productIds)];
  const specs = ids.length && port.productSpecs ? await port.productSpecs(ids) : new Map<string, { values: CatalogSpecValue[] }>();
  const fieldIds = [...new Set([...specs.values()].flatMap((s) => s.values.map((v) => v.fieldId)))];
  const mappings = await mappingsOf(platform, fieldIds);
  const org = adapter.responsibleFields ? await responsibleOrgOf(companyId) : null;
  return (product, attributes, overrides) =>
    resolveSpecAttributes(adapter, {
      attributes,
      overrides,
      product: { brand: product.brand, originCountry: product.originCountry, specs: specs.get(product.productId)?.values ?? [] },
      mappings,
      org: org as Record<string, string | null> | null,
    });
}

/**
 * Giá trị gửi lên sàn theo mã attribute, lấy từ `resolved` (AC-13, AC-15 của #400; #509). Select đổi sang nhãn của sàn (adapter
 * tự đổi nhãn sang mã nếu sàn cần). Hồ sơ công ty, thương hiệu mặc định adapter tự điền (`NewProduct.responsible`), nên bỏ.
 */
export function pushAttributes(
  attributes: readonly PlatformAttribute[] | null,
  resolved: Record<string, ResolvedValue>,
): Record<string, string | string[]> {
  const byCode = new Map((attributes ?? []).map((a) => [a.code, a]));
  const out: Record<string, string | string[]> = {};
  for (const [code, { value, source }] of Object.entries(resolved)) {
    if (source === 'company' || source === 'default') continue;
    const attr = byCode.get(code);
    out[code] = Array.isArray(value) ? value.map((v) => labelOf(attr, v)) : labelOf(attr, value);
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
  resolve: SpecResolver,
): Promise<{ missing: MissingItem[]; attributes: PlatformAttribute[] | null; resolved: Record<string, ResolvedValue> }> {
  const category = await findCategory(row.platform, row.externalCategoryId);
  const attributes = category?.attributesFetchedAt ? await leafAttributesOf(row.platform, row.externalCategoryId) : null;
  const resolved = resolve(product, attributes, row.attributes);
  const missing = specMissing({
    spec: row,
    attributes,
    axes: product.axes,
    fallbacks: resolvedValues(resolved),
    caps: attributes ? (adapter.variantCapabilities?.(attributes) ?? null) : null,
    variants: product.variantValues,
    platformName: adapter.name,
  });
  return { missing, attributes, resolved };
}

/** Attribute của leaf đã lấy về (chưa lấy thì null); đọc DB, không gọi sàn. Gọi trong `withCompany`. */
async function fetchedLeaf(platform: Marketplace, externalId: string): Promise<PlatformAttribute[] | null> {
  const category = await findCategory(platform, externalId);
  return category?.attributesFetchedAt ? leafAttributesOf(platform, externalId) : null;
}

type AxisSuggestionView = Pick<SpecView, 'suggestedAxisMap' | 'suggestedValueMap' | 'variantCapabilities'>;

const NO_SUGGESTION: AxisSuggestionView = { suggestedAxisMap: null, suggestedValueMap: null, variantCapabilities: null };

/**
 * Gợi ý ghép trục của sản phẩm cho một leaf (#448, Documents/21 §18.8.3): trục `axis_mappings` của công ty rồi mặc định theo
 * `platform_kind` của adapter, kèm khả năng khai biến thể của leaf. Leaf chưa có attribute thì cả ba null. Gọi trong `withCompany`.
 */
export async function axisSuggestion(
  adapter: MarketplaceAdapter,
  platform: Marketplace,
  externalId: string | null,
  product: SpecProduct,
): Promise<AxisSuggestionView> {
  const leaf = externalId ? await fetchedLeaf(platform, externalId) : null;
  if (!leaf) return NO_SUGGESTION;
  const caps = adapter.variantCapabilities?.(leaf) ?? null;
  const { axisMap, valueMap } = suggestAxes({
    axes: product.axes,
    leaf,
    companyCodes: await axisCodesOf(platform),
    standard: adapter.standardSalesAttributes ?? {},
    caps,
  });
  return {
    suggestedAxisMap: axisMap,
    suggestedValueMap: valueMap,
    variantCapabilities: caps && { ...caps, combineTarget: combineTarget(leaf) },
  };
}

/** Spec kèm `missing` như route `GET` trả (cũng là `current` của 409 `version_conflict`). Gọi trong `withCompany`. */
export async function specView(
  adapter: MarketplaceAdapter,
  row: ProductSpecRow | undefined,
  product: SpecProduct,
  resolve: SpecResolver,
  /** `platform` bắt buộc khi chưa có spec; `categoryId`: leaf chưa lưu cần tính gợi ý (#448), không có thì leaf của spec. */
  opts: { platform?: Marketplace; categoryId?: string } = {},
): Promise<SpecView> {
  const platform = row?.platform ?? opts.platform;
  const suggestion = platform ? await axisSuggestion(adapter, platform, opts.categoryId ?? row?.externalCategoryId ?? null, product) : NO_SUGGESTION;
  if (!row) return { spec: null, resolved: {}, missing: [], remote: null, ...suggestion };
  const { missing, resolved } = await missingOf(adapter, row, product, resolve);
  const category = await findCategory(row.platform, row.externalCategoryId);
  return {
    spec: toSpec(row, category && category.syncedAt ? category.path : null),
    resolved,
    missing,
    remote: await remoteOf(row),
    ...suggestion,
  };
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

/** Đọc spec của sản phẩm trên sàn; chưa có thì `spec: null`. */
export async function getProductSpec(
  ctx: ModuleContext,
  companyId: string,
  productId: string,
  raw: string,
  opts: { categoryId?: string } = {},
): Promise<SpecView> {
  const { platform, adapter } = platformOf(raw);
  // Leaf chưa lưu: lấy attribute (có thể gọi sàn) ngoài giao dịch như `PUT`, lỗi category thành 422 `errors.categoryId`.
  if (opts.categoryId !== undefined) await ensureLeafOr422(companyId, platform, adapter, opts.categoryId, 'categoryId');
  return withCompany(companyId, async () => {
    const variants = await variantsOf(ctx, productId);
    const row = await findSpec(productId, platform);
    const resolve = await specResolver(productPort(ctx), companyId, adapter, platform, [productId]);
    return specView(adapter, row, specProductOf(variants), resolve, {
      platform,
      ...(opts.categoryId !== undefined && { categoryId: opts.categoryId }),
    });
  });
}

/** `ensureLeaf` đổi lỗi category (không phải lá, sàn từ chối) thành 422 `errors.<field>`. */
async function ensureLeafOr422(companyId: string, platform: Marketplace, adapter: MarketplaceAdapter, externalId: string, field: string): Promise<void> {
  try {
    await ensureLeaf(companyId, platform, adapter, externalId);
  } catch (err) {
    if (err instanceof AppError && (err.code === 'category_not_leaf' || err.code === 'marketplace_rejected')) {
      throw new AppError(422, 'validation_failed', 'Dữ liệu không hợp lệ', {
        errors: { [field]: 'Category không phải category lá đang dùng được của sàn' },
      });
    }
    throw err;
  }
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

const sameValue = (a: SpecAttributeValue, b: SpecAttributeValue | undefined) =>
  b !== undefined && (Array.isArray(a) ? [...a].sort().join(' ') : a) === (Array.isArray(b) ? [...b].sort().join(' ') : b);

/**
 * Kiểm và chuẩn hoá tập ghi đè theo attribute của leaf (AC-6, AC-7 của #400; #509, Documents/21 §18.8.2). `attributes` là toàn
 * bộ tập ghi đè: khoá không gửi hoặc rỗng là không ghi đè; giá trị trùng giá trị của nguồn 2–4 (`defaults`: catalog, hồ sơ công
 * ty, mặc định sàn) thì không lưu. Ghi đè được mọi attribute không phải `sales`, kể cả thương hiệu, xuất xứ. Select lưu mã lựa
 * chọn. Bắt buộc kiểm trên giá trị sau khi áp ghi đè. Trả lỗi theo ô.
 */
export function normalizeSpec(
  input: SpecInput,
  attributes: readonly PlatformAttribute[],
  product: SpecProduct,
  defaults: Record<string, SpecAttributeValue>,
  /** Khả năng khai biến thể của leaf (#448); có thì `__custom` chỉ nhận khi sàn cho tên trục tự đặt. */
  caps: VariantCapabilities | null = null,
  /**
   * Đổi category (#593): thiếu attribute bắt buộc và trục chưa ghép không chặn lưu, chỉ báo trong `missing` (vẫn chặn đẩy).
   * Giá trị sai (lựa chọn không có, trục không phải sales, khoá lạ, ghép không hợp lệ) vẫn là lỗi.
   */
  { allowGaps = false }: { allowGaps?: boolean } = {},
): { values: Pick<SpecInput, 'attributes' | 'axisMap' | 'valueMap'>; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const out: Record<string, SpecAttributeValue> = {};
  const byCode = new Map(attributes.map((a) => [a.code, a]));
  for (const a of attributes) {
    if (a.kind === 'sales') continue;
    const value = input.attributes[a.code];
    const key = `attributes.${a.code}`;
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
    if (ids.length) out[a.code] = a.input === 'multiselect' ? ids : ids[0]!;
  }
  for (const [code, value] of Object.entries(out)) if (sameValue(value, defaults[code])) delete out[code];
  // Bắt buộc, bắt buộc theo điều kiện (sales không tính, chỉ kiểm qua trục). `tier = 'product'` (xuất xứ) không báo theo ô: ô ở
  // tab spec chỉ đọc, điền ở trang sản phẩm; `missing` báo và chặn đẩy (review BE2 P2-7).
  for (const m of allowGaps ? [] : specMissing({ spec: { attributes: { ...defaults, ...out }, axisMap: {}, categoryStatus: 'ok' }, attributes, axes: [] })) {
    if (byCode.get(m.code)?.tier === 'product') continue;
    if (m.reason === 'required' || m.reason === 'required_when') errors[`attributes.${m.code}`] ??= `Nhập ${m.label}`;
  }
  const sales = new Set(attributes.filter((a) => a.kind === 'sales').map((a) => a.code));
  const axisMap: Record<string, string> = {};
  for (const axis of product.axes) {
    const target = input.axisMap[axis.attributeId];
    if (target == null && allowGaps) continue;
    if (target === CUSTOM_AXIS && caps && !caps.customAxisName) {
      errors[`axisMap.${axis.attributeId}`] = 'Sàn này không nhận tên trục tự đặt, chọn thuộc tính phân loại của sàn';
    } else if (target == null || (target !== CUSTOM_AXIS && !sales.has(target))) {
      errors[`axisMap.${axis.attributeId}`] = `Chọn thuộc tính phân loại của sàn cho ${axis.name}`;
    } else axisMap[axis.attributeId] = target;
  }
  for (const key of Object.keys(input.axisMap)) {
    if (!product.axes.some((a) => a.attributeId === key)) errors[`axisMap.${key}`] = 'Không phải trục phân loại của sản phẩm';
  }
  // Nhiều trục cùng đích là thuộc tính biến thể ghép (#568, Documents/21 §18.8.3): đích phải nhận chữ ghép.
  const combined = new Set<string>();
  for (const g of axisGroups(axisMap, product.axes.map((a) => a.attributeId))) {
    if (g.attributeIds.length < 2) continue;
    g.attributeIds.forEach((id) => combined.add(id));
    if (targetCombinable(g.target, attributes)) continue;
    const label = byCode.get(g.target)?.label ?? g.target;
    for (const id of g.attributeIds) errors[`axisMap.${id}`] = `Thuộc tính biến thể ${label} của sàn không nhận chữ ghép, không ghép được`;
  }
  const valueMap: Record<string, string> = {};
  for (const [valueId, optionId] of Object.entries(input.valueMap)) {
    const axisId = product.valueIds.get(valueId);
    if (axisId && combined.has(axisId)) {
      errors[`valueMap.${valueId}`] = 'Giá trị của thuộc tính biến thể ghép gửi nguyên chữ ghép, không chọn lựa chọn của sàn';
      continue;
    }
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
  const product = await withCompany(companyId, async () => specProductOf(await variantsOf(ctx, productId)));
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
    const resolve = await specResolver(productPort(ctx), companyId, adapter, platform, [productId]);
    const defaults = resolvedValues(resolve(product, attributes, {}));
    const before = await findSpec(productId, platform);
    // Đổi category (#593): attribute, trục của category cũ không dùng được nên FE gửi rỗng; thiếu thì lưu được, báo trong
    // `missing` để điền tiếp ở tab sàn. Category không đổi, hoặc gửi
    // `version: null` khi spec đã có (bản cũ, sẽ 409/422), thì kiểm chặt như cũ.
    const categoryChanged = Boolean(before && input.version !== null && before.externalCategoryId !== input.externalCategoryId);
    // Lần lưu đầu hoặc đổi category: trục, giá trị người dùng chưa chọn thì điền theo gợi ý (#448); còn lại không tự điền để
    // không đè lựa chọn.
    const body = input.version === null || categoryChanged ? await withSuggestion(adapter, platform, product, input) : input;
    const { values, errors } = normalizeSpec(body, attributes, product, defaults, adapter.variantCapabilities?.(attributes) ?? null, {
      allowGaps: categoryChanged,
    });
    if (Object.keys(errors).length) throw new AppError(422, 'validation_failed', 'Dữ liệu không hợp lệ', { errors });
    const conflict = async () => {
      const current = await findSpec(productId, platform);
      return new AppError(409, 'version_conflict', 'Thông tin sàn của sản phẩm vừa được người khác sửa', {
        current: current ? (await specView(adapter, current, product, resolve)).spec : null,
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
    return specView(adapter, row, product, resolve);
  });
}

/** `input` với `axisMap`, `valueMap` còn thiếu được điền từ gợi ý ghép trục của leaf; giá trị đã gửi giữ nguyên. Gọi trong `withCompany`. */
async function withSuggestion(adapter: MarketplaceAdapter, platform: Marketplace, product: SpecProduct, input: SpecInput): Promise<SpecInput> {
  const { suggestedAxisMap, suggestedValueMap } = await axisSuggestion(adapter, platform, input.externalCategoryId, product);
  if (!suggestedAxisMap || !suggestedValueMap) return input;
  const axisMap = { ...input.axisMap };
  for (const axis of product.axes) if (axisMap[axis.attributeId] == null && suggestedAxisMap[axis.attributeId] != null) axisMap[axis.attributeId] = suggestedAxisMap[axis.attributeId]!;
  const valueMap = { ...input.valueMap };
  // Trục ghép không có ánh xạ giá trị (#568)
  const combined = new Set(axisGroups(axisMap, product.axes.map((a) => a.attributeId)).flatMap((g) => (g.attributeIds.length > 1 ? g.attributeIds : [])));
  for (const [valueId, optionId] of Object.entries(suggestedValueMap)) {
    const axisId = product.valueIds.get(valueId);
    if (valueMap[valueId] === undefined && axisId !== undefined && !combined.has(axisId) && axisMap[axisId] === suggestedAxisMap[axisId]) {
      valueMap[valueId] = optionId;
    }
  }
  return { ...input, axisMap, valueMap };
}

/** Spec kèm attribute leaf đã đọc, để việc nền dựng `NewProduct` mà không đọc lại. */
export interface SpecCheckFull extends SpecCheck {
  row: ProductSpecRow;
  attributes: PlatformAttribute[] | null;
  product: SpecProduct;
  resolved: Record<string, ResolvedValue>;
}

/**
 * Tình trạng spec của các sản phẩm với một gian hàng, theo lô (request đẩy, việc nền, bảng listing): `missing` theo attribute
 * đã có, quyền category đã ghi của gian hàng, luật bảng kích cỡ của category (`platform_categories`). Gọi trong `withCompany`. `variants`: mọi biến thể của các sản phẩm cần xét.
 */
export async function specChecks(
  port: Pick<ProductPort, 'productSpecs'>,
  shop: { id: string; companyId: string; platform: Marketplace },
  adapter: MarketplaceAdapter,
  variants: readonly ListingVariant[],
): Promise<Map<string, SpecCheckFull>> {
  const specs = await specsOf([...new Set(variants.map((v) => v.productId))], shop.platform);
  if (!specs.size) return new Map();
  const resolve = await specResolver(port, shop.companyId, adapter, shop.platform, [...specs.keys()]);
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
    const resolved = resolve(product, attributes, row.attributes);
    const missing = specMissing({
      spec: row,
      attributes,
      axes: product.axes,
      fallbacks: resolvedValues(resolved),
      caps: attributes ? (adapter.variantCapabilities?.(attributes) ?? null) : null,
      variants: product.variantValues,
      platformName: adapter.name,
    });
    out.set(productId, {
      externalCategoryId: row.externalCategoryId,
      missing,
      permission: permissions.get(row.externalCategoryId)?.status ?? null,
      sizeChartRule: category?.sizeChartRule ?? null,
      row,
      attributes,
      product,
      resolved,
    });
  }
  return out;
}

/** `specStatus` của dòng listing (§18.5): theo lô, không gọi sàn. */
export function specStatusOf(check: SpecCheck | undefined): 'complete' | 'incomplete' | 'missing' {
  if (!check) return 'missing';
  return check.missing.length ? 'incomplete' : 'complete';
}
