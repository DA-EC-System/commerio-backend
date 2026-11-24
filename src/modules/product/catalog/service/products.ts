// Sản phẩm (UC-CP-02, UC-CP-04; Documents/21 5.2–5.4, C3, C5, P5–P8, V22, V24; D9; plan #12 B1, B2, B6).
import { Decimal } from 'decimal.js';
import { withCompany } from '../../../../shared/db/client.ts';
import { confirmUploads, fileProblem, publicFileUrls, recordAudit } from '../../../core/index.ts';
import { countLabels, type LabelledSku } from '../domain/labels.ts';
import { findGroups } from '../repository/groups.ts';
import { productImageRows, replaceProductImages } from '../repository/product-images.ts';
import {
  deleteProductTree,
  findProduct,
  insertProduct,
  listProducts as findPage,
  lockProduct,
  type ProductExtras,
  type ProductFilter,
  type ProductRow,
  productNameExists,
  setSizeChart,
  updateProductIfVersion,
} from '../repository/products.ts';
import { deleteVariantImages, upsertVariantImage, variantImageRows } from '../repository/variant-images.ts';
import { findVariants, insertVariant, lockProductVariants, lockVariants, type VariantRow } from '../repository/variants.ts';
import {
  auditOf,
  type Caller,
  invalid,
  isUuid,
  listingFieldRequired,
  nameTaken,
  notFound,
  pgError,
  productInUse,
  versionConflict,
} from './errors.ts';
import { type SkuLabels, skuLabels } from './labels.ts';
import { listedImageErrors } from './listed-fields.ts';
import { applySpecs, checkSpecs, productSpecsView, type SpecValueInput } from './product-specs.ts';
import { attributeValueImagesOf, imagesOf, MAX_PRODUCT_IMAGES, sizeChartOf, type VariantImage, variantImagesOf } from './product-images.ts';
import { type AxisInput, checkAxes, createAxes } from './axes.ts';
import { allocateSkus, productCodeFor, SKU_TOO_LONG } from './sku-allocation.ts';
import { type CatalogContext, standardPricesOf } from './standard-price.ts';
import { archiveBlockersOf, inUseOf, requirePort } from './usage.ts';

export interface CreateProductInput {
  name: string;
  groupId: string;
  description: string;
  /** Id tệp ảnh theo thứ tự, ảnh đầu là ảnh đại diện (#303). */
  imageFileIds?: string[] | undefined;
  /** Id tệp ảnh bảng kích cỡ (#347); bỏ trống là chưa có. */
  sizeChartFileId?: string | null | undefined;
  /** Trục phân loại (tối đa 2, đã kiểm hình dạng ở Zod); thuộc tính, giá trị mới tạo cùng giao dịch. */
  axes: AxisInput[];
  /** `options[i]` là một giá trị của `axes[i]` (so `lower(trim)`); giá, số đo điền ngay lúc tạo (#510). */
  variants: ({ options: string[] } & Partial<Record<VariantFact, number | null | undefined>>)[];
  /** Chỉ số trục gắn ảnh; ảnh phân loại ở `axes[imageAxis].values[].imageFileId` (#510, đã kiểm hình dạng ở Zod). */
  imageAxis?: 0 | 1 | undefined;
  /** Thông số (#510, Documents/21 mục 5.5); thiếu thông số bắt buộc không chặn lưu. */
  specs?: SpecValueInput[] | undefined;
  /** Xuất xứ, thương hiệu điền ngay lúc tạo (#510). */
  originCountry?: string | null | undefined;
  brand?: string | null | undefined;
}

export interface UpdateProductInput {
  name: string;
  description: string;
  /** Không gửi thì giữ nguyên ảnh; gửi thì thay toàn bộ (`[]` gỡ hết). */
  imageFileIds?: string[] | undefined;
  /** Không gửi thì giữ nguyên bảng kích cỡ; `null` gỡ, id tệp thì thay (#347). */
  sizeChartFileId?: string | null | undefined;
  /** Thuộc tính gắn ảnh, xuất xứ, thương hiệu (#340): không gửi thì giữ, `null` bỏ chọn / xoá. */
  imageAttributeId?: string | null | undefined;
  originCountry?: string | null | undefined;
  brand?: string | null | undefined;
  /** Đổi nhóm hàng (P6, 19/11/2026); SKU không đổi. */
  groupId?: string | undefined;
  /** Thay giá trị của từng `fieldId` có trong mảng (#510); thông số không gửi giữ nguyên. */
  specs?: SpecValueInput[] | undefined;
  version: number;
}

const ENTITY = 'product.products';
const NOT_AXIS = 'Thuộc tính không phải trục phân loại của sản phẩm';
const taken = () => nameTaken('Đã có sản phẩm cùng tên');

/**
 * `thumbnailUrl`: link ảnh đại diện; chuỗi rỗng (thiếu `S3_PUBLIC_URL`) coi như không có ảnh. Số đếm và `status` suy từ
 * nhãn của mọi SKU con (#204, Documents/21 §17.1): `archived` khi mọi SKU đã lưu trữ.
 */
function toListItem(p: ProductRow, thumbnailUrl: string | null, skus: readonly LabelledSku[]) {
  const counts = countLabels(skus);
  return {
    id: p.id,
    name: p.name,
    code: p.code,
    group: { id: p.groupId, name: p.groupName },
    ...counts,
    thumbnailUrl: thumbnailUrl || null,
    status: counts.variantCount > 0 ? ('active' as const) : ('archived' as const),
    updatedAt: p.updatedAt.toISOString(),
    version: p.version,
  };
}

/** Giá trên API là số nguyên đồng (G1); DB giữ chuỗi `numeric`, service giữ Decimal. */
export function toDong(value: Decimal | string | null): number | null {
  return value === null ? null : new Decimal(value).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
}

/**
 * `labels`: độ hoàn thiện, ngưỡng tồn, hiện diện trên sàn (`skuLabels`). `archiveBlockers`: lý do chưa lưu trữ được, chỉ
 * tính cho SKU `discontinued` (Documents/21 §17.1, spec 204 mục 5.2).
 */
export function toVariantView(
  v: VariantRow,
  labels: SkuLabels,
  standardPrice: Decimal | null = null,
  archiveBlockers: readonly string[] = [],
  image: VariantImage | null = null,
) {
  return {
    id: v.id,
    sku: v.sku,
    attributes: v.attributes.map(({ code: _, platformKind: __, scope: ___, valueScope: ____, ...a }) => a),
    archivedAt: v.archivedAt?.toISOString() ?? null,
    businessStatus: v.businessStatus,
    standardPrice: toDong(standardPrice),
    targetNetPrice: toDong(v.targetNetPrice),
    weightG: v.weightG,
    lengthMm: v.lengthMm,
    widthMm: v.widthMm,
    heightMm: v.heightMm,
    version: v.version,
    archiveBlockers: [...archiveBlockers],
    image,
    ...labels,
    missing: [...labels.missing],
  };
}

/**
 * `archiveBlockers: false` cho người không có `catalog.product.manage`: câu lý do chặn lưu trữ có số tồn, số mua hàng, chỉ
 * người lưu trữ được mới cần (review PR 2).
 */
export async function productDetail(
  ctx: CatalogContext,
  p: ProductRow,
  variants?: VariantRow[],
  { archiveBlockers = true }: { archiveBlockers?: boolean } = {},
) {
  const rows = variants ?? (await findVariants({ productId: p.id }));
  const prices = await standardPricesOf(ctx, rows.map((v) => v.id));
  // Chỉ SKU ngừng nhập mới có nút Lưu trữ: không có SKU nào như vậy thì không hỏi bốn nguồn.
  const discontinued = archiveBlockers ? rows.filter((v) => v.businessStatus === 'discontinued').map((v) => v.id) : [];
  const blockers = await archiveBlockersOf(ctx, discontinued);
  const images = await imagesOf(p.id);
  const labels = await skuLabels(ctx, rows, () => ({ name: p.name, imageCount: images.length }));
  const variantImages = await variantImagesOf(rows);
  const views = rows.map((v) =>
    toVariantView(v, labels.get(v.id)!, prices.get(v.id) ?? null, blockers.get(v.id), variantImages.get(v.id)),
  );
  return {
    ...toListItem(p, images[0]?.url ?? null, views),
    description: p.description ?? '',
    images,
    sizeChart: await sizeChartOf(p.sizeChartFileId),
    imageAttributeId: p.imageAttributeId,
    attributeValueImages: await attributeValueImagesOf(p.id),
    originCountry: p.originCountry,
    brand: p.brand,
    ...(await productSpecsView(p.id, p.groupId)),
    variants: views,
  };
}
export type ProductDetail = Awaited<ReturnType<typeof productDetail>>;

/** Sản phẩm của công ty đang chọn; không có, không phải uuid hay của công ty khác đều 404 (C4, V6). */
export async function findOwnProduct(id: string): Promise<ProductRow> {
  const product = isUuid(id) ? await findProduct(id) : undefined;
  if (!product) throw notFound('sản phẩm');
  return product;
}

function snapshot(
  p: { name: string; description: string | null },
  group: string,
  variants: { sku: string; archivedAt: unknown }[],
  imageFileIds: readonly string[],
  sizeChartFileId: string | null = null,
  extras: ProductExtras = {},
) {
  return {
    name: p.name,
    group,
    description: p.description ?? '',
    imageFileIds: [...imageFileIds],
    ...(sizeChartFileId && { sizeChartFileId }),
    // Chỉ nêu khi có giá trị, như `sizeChartFileId` (#340).
    ...(extras.imageAttributeId && { imageAttributeId: extras.imageAttributeId }),
    ...(extras.originCountry && { originCountry: extras.originCountry }),
    ...(extras.brand && { brand: extras.brand }),
    variants: variants.filter((v) => !v.archivedAt).map((v) => v.sku),
  };
}

const extrasOf = (p: ProductRow): ProductExtras => ({ imageAttributeId: p.imageAttributeId, originCountry: p.originCountry, brand: p.brand });

/** Id tệp ảnh đang gắn, theo thứ tự (cho nhật ký). Gọi trong `withCompany`. */
async function imageIdsOf(productId: string): Promise<string[]> {
  return (await productImageRows([productId])).map((r) => r.fileId);
}

function race(err: unknown): never {
  const { code, constraint } = pgError(err);
  if (code === '23505' && constraint?.startsWith('products_')) throw taken();
  // Giá trị mới của trục đụng giá trị, mã vừa được `PUT /attributes` thêm (route đó không lấy khoá công ty).
  if (code === '23505' && constraint?.startsWith('attribute_values_')) throw invalid({ axes: 'Thuộc tính vừa được sửa, thử lại' });
  // Nhóm hàng hay giá trị vừa bị xoá giữa lúc đọc và lúc ghi.
  if (code === '23503' && constraint?.startsWith('products_group_id')) throw invalid({ groupId: 'Danh mục sản phẩm vừa bị xoá' });
  if (code === '23503' && constraint?.startsWith('variant_attribute_values_')) throw invalid({ variants: 'Có giá trị thuộc tính vừa bị xoá' });
  if (code === '23503' && constraint === 'products_image_attribute_id_attributes_id_fk') throw invalid({ imageAttributeId: NOT_AXIS });
  throw err;
}

/**
 * Một trang danh sách với số câu truy vấn cố định (#204 Review Focus 2): trang sản phẩm, SKU của cả trang, ngưỡng tồn,
 * hiện diện, link ảnh đại diện mỗi thứ một lần, không theo số dòng.
 */
/** Độ phủ sàn của một sản phẩm theo gian hàng (FE#464): `listed` + `missing` = số SKU chưa lưu trữ. */
export interface ShopCoverage {
  shopId: string;
  shopName: string;
  platform: string;
  listed: number;
  missing: number;
}

/**
 * `channel`: người xem có `channel.shop.view` thì kèm `channelCoverage`; không có thì mảng rỗng, không hỏi channel
 * (FE#464).
 */
export async function listProducts(ctx: CatalogContext, companyId: string, filter: ProductFilter, { channel = false }: { channel?: boolean } = {}) {
  return withCompany(companyId, async () => {
    const { rows, total } = await findPage(filter);
    const variants = rows.length ? await findVariants({ productIds: rows.map((p) => p.id) }) : [];
    // Độ hoàn thiện chỉ cần cha có ảnh hay không: ảnh `position` 0 có khi và chỉ khi có ảnh.
    const parents = new Map(rows.map((p) => [p.id, { name: p.name, imageCount: p.thumbnailFileId ? 1 : 0 }]));
    const labels = await skuLabels(ctx, variants, (id) => parents.get(id)!);
    const skusOf = Map.groupBy(
      variants.map((v) => ({ productId: v.productId, businessStatus: v.businessStatus, ...labels.get(v.id)! })),
      (s) => s.productId,
    );
    const urls = await publicFileUrls(rows.flatMap((p) => (p.thumbnailFileId ? [p.thumbnailFileId] : [])));
    const active = variants.filter((v) => v.businessStatus !== 'archived');
    const coverage = channel && rows.length ? await requirePort(ctx, 'channelCoverageOf')(active.map((v) => v.id)) : null;
    const activeOf = Map.groupBy(active, (v) => v.productId);
    const coverageOf = (productId: string): ShopCoverage[] => {
      if (!coverage) return [];
      const own = activeOf.get(productId) ?? [];
      return coverage.shops.map((s) => {
        const listed = own.filter((v) => coverage.listedShops.get(v.id)?.has(s.shopId)).length;
        return { ...s, listed, missing: own.length - listed };
      });
    };
    const items = rows.map((p) => ({
      ...toListItem(p, p.thumbnailFileId ? (urls.get(p.thumbnailFileId) ?? null) : null, skusOf.get(p.id) ?? []),
      channelCoverage: coverageOf(p.id),
    }));
    return { items, total, page: filter.page, pageSize: filter.pageSize };
  });
}

export async function getProduct(
  ctx: CatalogContext,
  companyId: string,
  id: string,
  options: { archiveBlockers: boolean },
): Promise<ProductDetail> {
  return withCompany(companyId, async () => productDetail(ctx, await findOwnProduct(id), undefined, options));
}

/**
 * Ảnh (#303): `confirmUploads` hỏi kho **trước** giao dịch (gọi mạng); trong giao dịch `fileProblem` kiểm tệp của công
 * ty, đúng `product_image`, đã PUT xong. Số ảnh, ảnh lặp đã kiểm ở Zod.
 */
type VariantFact = 'standardPrice' | 'targetNetPrice' | 'weightG' | 'lengthMm' | 'widthMm' | 'heightMm';

/** Giá, số đo của một biến thể lúc tạo: giá là cột `numeric` (chuỗi), số đo là `integer`; bỏ trường hay `null` là trống. */
function variantFacts(v: CreateProductInput['variants'][number]) {
  const out: Parameters<typeof insertVariant>[6] = {};
  if (v.standardPrice != null) out.standardPrice = String(v.standardPrice);
  if (v.targetNetPrice != null) out.targetNetPrice = String(v.targetNetPrice);
  for (const k of ['weightG', 'lengthMm', 'widthMm', 'heightMm'] as const) if (v[k] != null) out[k] = v[k];
  return out;
}

export async function createProduct(ctx: CatalogContext, caller: Caller, input: CreateProductInput) {
  const imageIds = input.imageFileIds ?? [];
  const sizeChartId = input.sizeChartFileId ?? null;
  // Ảnh phân loại theo vị trí trục, giá trị (giá trị có thể mới tạo trong cùng request nên chưa có id; #510).
  const valueImages =
    input.imageAxis === undefined
      ? []
      : input.axes[input.imageAxis]!.values.flatMap((v, j) => (v.imageFileId === undefined ? [] : [{ j, value: v.value, fileId: v.imageFileId }]));
  await confirmUploads(caller.companyId, [...imageIds, ...(sizeChartId ? [sizeChartId] : []), ...valueImages.map((v) => v.fileId)]);
  return withCompany(caller.companyId, async () => {
    await lockVariants(caller.companyId);
    // Khoá ngoại kiểm bằng quyền chủ bảng, bỏ qua RLS: đọc nhóm, thuộc tính, giá trị dưới công ty mình trước khi ghi.
    const [group] = isUuid(input.groupId) ? await findGroups(input.groupId) : [];
    const checked = await checkAxes(input.axes);
    const specCheck = await checkSpecs(input.specs ?? []);
    const imageError = await fileProblem(imageIds, 'product_image', MAX_PRODUCT_IMAGES);
    const sizeChartError = sizeChartId ? await fileProblem([sizeChartId], 'product_image', 1) : null;
    const errors: Record<string, string> = { ...checked.errors, ...specCheck.errors };
    if (!group) errors.groupId = 'Chọn danh mục sản phẩm';
    if (imageError) errors.images = imageError;
    if (sizeChartError) errors.sizeChart = sizeChartError;
    for (const v of valueImages) {
      const problem = await fileProblem([v.fileId], 'product_image', 1);
      if (problem) errors[`axes.${input.imageAxis}.values.${v.j}.imageFileId`] = problem;
    }
    if (Object.keys(errors).length) throw invalid(errors);
    if (await productNameExists(input.name)) throw taken();

    // Từ đây là ghi: lỗi sau bước này (SKU quá dài) rollback cả thuộc tính, giá trị vừa tạo.
    const axes = await createAxes(caller.companyId, input.axes, checked.found);
    const combos = input.variants.map((v) => v.options.map((o, k) => axes[k]!.values.get(o.trim().toLowerCase())!));
    const allocation = await allocateSkus(caller.companyId, combos);
    if (!allocation.ok) throw invalid({ [`variants.${allocation.index}`]: SKU_TOO_LONG });
    const code = await productCodeFor(allocation.pattern, allocation.skus[0]!.seq);
    const createExtras: ProductExtras = {
      ...(input.originCountry && { originCountry: input.originCountry }),
      ...(input.brand && { brand: input.brand }),
      ...(input.imageAxis !== undefined && { imageAttributeId: axes[input.imageAxis]!.attributeId }),
    };
    const id = await insertProduct(caller.companyId, group!.id, input.name, input.description, code, createExtras);
    const specLog = await applySpecs(caller.companyId, id, specCheck.plans);
    for (const [i, combo] of combos.entries()) {
      await insertVariant(caller.companyId, id, allocation.skus[i]!.sku, combo.map((v) => v.id), i, null, variantFacts(input.variants[i]!));
    }
    for (const v of valueImages) {
      const value = axes[input.imageAxis!]!.values.get(v.value.trim().toLowerCase())!;
      await upsertVariantImage({ companyId: caller.companyId, productId: id, attributeId: createExtras.imageAttributeId!, attributeValueId: value.id, fileId: v.fileId });
    }
    await replaceProductImages(caller.companyId, id, imageIds);
    if (sizeChartId) await setSizeChart(id, sizeChartId);
    const result = await productDetail(ctx, await findOwnProduct(id));
    await recordAudit({
      ...auditOf(caller, 'create', ENTITY, id),
      label: input.name,
      after: {
        ...snapshot(input, group!.name, result.variants, imageIds, sizeChartId, createExtras),
        code,
        ...(Object.keys(specLog.after).length && { specs: specLog.after }),
      },
    });
    return result;
  }).catch(race);
}

/** Dùng cả khi kiểm trước lúc ghi lẫn khi ghi có điều kiện `version` không trúng (người khác vừa sửa). */
async function rejectStale(ctx: CatalogContext, product: ProductRow): Promise<never> {
  throw versionConflict(`Sản phẩm "${product.name}" vừa được người khác sửa`, await productDetail(ctx, product));
}

/**
 * Ảnh như `createProduct`; không gửi `imageFileIds` thì giữ nguyên, gửi thì thay toàn bộ sau khi ghi trúng `version`.
 * Gửi `imageFileIds: []` khi sản phẩm còn ảnh và có SKU còn listing chưa gỡ: 409 `listing_field_required`.
 */
export async function updateProduct(ctx: CatalogContext, caller: Caller, id: string, input: UpdateProductInput) {
  const imageIds = input.imageFileIds;
  const sizeChartId = input.sizeChartFileId;
  const toConfirm = [...(imageIds ?? []), ...(sizeChartId ? [sizeChartId] : [])];
  if (toConfirm.length) await confirmUploads(caller.companyId, toConfirm);
  return withCompany(caller.companyId, async () => {
    let product = await findOwnProduct(id);
    // Đổi thuộc tính gắn ảnh (#340): khoá dòng sản phẩm như route ảnh phân loại rồi đọc lại, để ảnh vừa đặt không chen
    // giữa lúc xoá ảnh và lúc ghi thuộc tính mới.
    if (input.imageAttributeId !== undefined && input.imageAttributeId !== product.imageAttributeId) {
      await lockProduct(id);
      product = await findOwnProduct(id);
    }
    if (product.version !== input.version) await rejectStale(ctx, product);
    const changesImageAttribute = input.imageAttributeId !== undefined && input.imageAttributeId !== product.imageAttributeId;
    const variants = await findVariants({ productId: id });
    const errors: Record<string, string> = {};
    if (imageIds) {
      const imageError = await fileProblem(imageIds, 'product_image', MAX_PRODUCT_IMAGES);
      if (imageError) errors.images = imageError;
    }
    if (sizeChartId) {
      const sizeChartError = await fileProblem([sizeChartId], 'product_image', 1);
      if (sizeChartError) errors.sizeChart = sizeChartError;
    }
    // Trục đọc qua RLS từ SKU: thuộc tính công ty khác hay id lạ đều không phải trục (khoá ngoại bỏ qua RLS).
    const axes = new Set(variants.flatMap((v) => v.attributes.map((a) => a.attributeId)));
    // `!= null`: chuỗi rỗng cũng là id sai (422), không lọt xuống UPDATE thành 500.
    if (input.imageAttributeId != null && !axes.has(input.imageAttributeId)) errors.imageAttributeId = NOT_AXIS;
    // Đổi nhóm (P6): nhóm đọc qua RLS, nhóm công ty khác hay id lạ là 422; SKU không đổi.
    const changesGroup = input.groupId !== undefined && input.groupId !== product.groupId;
    const [newGroup] = changesGroup && isUuid(input.groupId!) ? await findGroups(input.groupId) : [];
    if (changesGroup && !newGroup) errors.groupId = 'Chọn danh mục sản phẩm';
    const specCheck = await checkSpecs(input.specs ?? []);
    Object.assign(errors, specCheck.errors);
    if (Object.keys(errors).length) throw invalid(errors);
    if (await productNameExists(input.name, id)) throw taken();
    const imagesBefore = await imageIdsOf(id);
    // Gỡ hết ảnh khi còn listing chưa gỡ (US-SP-03 dòng 7): 409, không ghi gì.
    const listed = await listedImageErrors(ctx, variants.map((v) => v.id), imagesBefore, imageIds);
    if (listed) throw listingFieldRequired(listed.detail, listed.errors);
    const extras: ProductExtras = {
      ...(changesImageAttribute && { imageAttributeId: input.imageAttributeId }),
      ...(input.originCountry !== undefined && { originCountry: input.originCountry }),
      ...(input.brand !== undefined && { brand: input.brand }),
      ...(newGroup && { groupId: newGroup.id }),
    };
    // Khoá ngoại ghép `pavi_product_fk` bắt xoá ảnh cũ trước khi đổi thuộc tính; sai `version` thì cả giao dịch lùi lại.
    // Ảnh phân loại gỡ kèm ghi vào nhật ký như route ảnh, để truy được ảnh nào mất (#340, review N2).
    const removedImages = changesImageAttribute
      ? (await variantImageRows([id])).map((r) => ({ attributeValueId: r.attributeValueId, fileId: r.fileId }))
      : [];
    if (changesImageAttribute) await deleteVariantImages(id);
    if (!(await updateProductIfVersion(id, input.version, input.name, input.description, extras))) {
      await rejectStale(ctx, await findOwnProduct(id));
    }
    if (imageIds) await replaceProductImages(caller.companyId, id, imageIds);
    if (sizeChartId !== undefined) await setSizeChart(id, sizeChartId);
    const specLog = await applySpecs(caller.companyId, id, specCheck.plans);
    const sizeChartAfter = sizeChartId === undefined ? product.sizeChartFileId : sizeChartId;
    await recordAudit({
      ...auditOf(caller, 'update', ENTITY, id),
      label: input.name ?? product.name,
      before: {
        ...snapshot(product, product.groupName, variants, imagesBefore, product.sizeChartFileId, extrasOf(product)),
        ...(removedImages.length && { attributeValueImages: removedImages }),
        ...(Object.keys(specLog.before).length && { specs: specLog.before }),
      },
      after: {
        ...snapshot(input, newGroup?.name ?? product.groupName, variants, imageIds ?? imagesBefore, sizeChartAfter, {
          ...extrasOf(product),
          ...extras,
        }),
        ...(Object.keys(specLog.after).length && { specs: specLog.after }),
      },
    });
    // Đổi thuộc tính gắn ảnh thì `variants` còn mang ảnh cũ: đọc lại.
    return productDetail(ctx, await findOwnProduct(id), changesImageAttribute ? undefined : variants);
  }).catch(race);
}

/**
 * `DELETE /catalog/products/:id`: xoá hẳn (#204 spec mục 6, Documents/21 §17.2). Chỉ khi mọi SKU chờ hoàn thiện, không
 * module nào đã dùng SKU (`inUseOf`), không SKU nào sinh từ đề nghị nhập; ngược lại 409 `product_in_use`. Lưu trữ sản
 * phẩm cha kiểu cũ đã bỏ: lưu trữ từng SKU qua `business-status`.
 *
 * Thứ tự khoá: khoá công ty (cùng thêm biến thể, đổi trạng thái) → dòng SKU theo id → dòng sản phẩm → dòng tồn (inventory
 * xoá cuối), cùng chiều với PATCH SKU và sửa hàng loạt (SKU → sản phẩm → dòng tồn). Khoá trước khi đọc để PATCH SKU, PUT
 * sản phẩm không làm SKU hoàn thiện giữa lúc kiểm và lúc xoá.
 */
export async function deleteProduct(ctx: CatalogContext, caller: Caller, id: string, version: number): Promise<void> {
  await withCompany(caller.companyId, async () => {
    await lockVariants(caller.companyId);
    await findOwnProduct(id);
    await lockProductVariants(id);
    if ((await lockProduct(id)) !== version) await rejectStale(ctx, await findOwnProduct(id));
    const product = await findOwnProduct(id);
    const variants = await findVariants({ productId: id });
    const ids = variants.map((v) => v.id);
    const imageIds = await imageIdsOf(id);
    const parent = { name: product.name, imageCount: imageIds.length };
    const labels = await skuLabels(ctx, variants, () => parent);
    if (variants.some((v) => labels.get(v.id)!.readiness === 'ready')) {
      throw productInUse('Sản phẩm có SKU đã hoàn thiện, không xoá hẳn được; lưu trữ từng SKU');
    }
    if ((await inUseOf(ctx, ids)).size) throw productInUse('Sản phẩm đã có chứng từ hoặc listing, không xoá hẳn được; lưu trữ từng SKU');
    if (variants.some((v) => v.sourceRequestLineId)) throw productInUse('Sản phẩm sinh từ đơn đặt hàng nhập, không xoá hẳn được');
    await requirePort(ctx, 'deleteStockLevels')(ids);
    await deleteProductTree(id, ids);
    await recordAudit({
      ...auditOf(caller, 'delete', ENTITY, id),
      label: product.name,
      before: { ...snapshot(product, product.groupName, variants, imageIds, product.sizeChartFileId), code: product.code },
    });
  });
}
