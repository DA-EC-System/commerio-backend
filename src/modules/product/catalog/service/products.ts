// Sản phẩm (UC-CP-02, UC-CP-04; Documents/21 5.2–5.4, C3, C5, P5–P8, V22, V24; D9; plan #12 B1, B2, B6).
import { Decimal } from 'decimal.js';
import { withCompany } from '../../../../shared/db/client.ts';
import { confirmUploads, fileProblem, publicFileUrls, recordAudit } from '../../../core/index.ts';
import { findCategories } from '../repository/categories.ts';
import { productImageRows, replaceProductImages } from '../repository/product-images.ts';
import {
  archiveProductIfVersion,
  findProduct,
  insertProduct,
  listProducts as findPage,
  type ProductFilter,
  type ProductRow,
  productNameExists,
  setSizeChart,
  updateProductIfVersion,
} from '../repository/products.ts';
import { findVariants, insertVariant, lockVariants, type VariantRow } from '../repository/variants.ts';
import {
  auditOf,
  type Caller,
  invalid,
  isUuid,
  nameTaken,
  notFound,
  pgError,
  productArchived,
  versionConflict,
} from './errors.ts';
import { imagesOf, MAX_PRODUCT_IMAGES, sizeChartOf } from './product-images.ts';
import { allocateSkus, resolveCombos } from './sku-allocation.ts';
import { type CatalogContext, standardPricesOf } from './standard-price.ts';
import { archiveBlockersOf } from './usage.ts';

export interface CreateProductInput {
  name: string;
  categoryId: string;
  description: string;
  /** Id tệp ảnh theo thứ tự, ảnh đầu là ảnh đại diện (#303). */
  imageFileIds?: string[] | undefined;
  /** Id tệp ảnh bảng kích cỡ (#347); bỏ trống là chưa có. */
  sizeChartFileId?: string | null | undefined;
  variants: { attributeValueIds: string[] }[];
}

export interface UpdateProductInput {
  name: string;
  description: string;
  /** Không gửi thì giữ nguyên ảnh; gửi thì thay toàn bộ (`[]` gỡ hết). */
  imageFileIds?: string[] | undefined;
  /** Không gửi thì giữ nguyên bảng kích cỡ; `null` gỡ, id tệp thì thay (#347). */
  sizeChartFileId?: string | null | undefined;
  version: number;
}

const ENTITY = 'product.products';
const taken = () => nameTaken('Đã có sản phẩm cùng tên');

/** `thumbnailUrl`: link ảnh đại diện; chuỗi rỗng (thiếu `S3_PUBLIC_URL`) coi như không có ảnh. */
function toListItem(p: ProductRow, thumbnailUrl: string | null) {
  return {
    id: p.id,
    name: p.name,
    category: { id: p.categoryId, name: p.categoryName },
    variantCount: p.variantCount,
    thumbnailUrl: thumbnailUrl || null,
    status: p.archivedAt ? ('archived' as const) : ('active' as const),
    updatedAt: p.updatedAt.toISOString(),
    version: p.version,
  };
}

/** Giá trên API là số nguyên đồng (G1); DB giữ chuỗi `numeric`, service giữ Decimal. */
export function toDong(value: Decimal | string | null): number | null {
  return value === null ? null : new Decimal(value).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
}

/** `archiveBlockers`: lý do chưa lưu trữ được, chỉ tính cho SKU `discontinued` (Documents/21 §17.1, spec 204 mục 5.2). */
export function toVariantView(v: VariantRow, standardPrice: Decimal | null = null, archiveBlockers: readonly string[] = []) {
  return {
    id: v.id,
    sku: v.sku,
    attributes: v.attributes.map(({ code: _, ...a }) => a),
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
  return {
    ...toListItem(p, images[0]?.url ?? null),
    description: p.description ?? '',
    images,
    sizeChart: await sizeChartOf(p.sizeChartFileId),
    variants: rows.map((v) => toVariantView(v, prices.get(v.id) ?? null, blockers.get(v.id))),
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
  category: string,
  variants: { sku: string; archivedAt: unknown }[],
  imageFileIds: readonly string[],
  sizeChartFileId: string | null = null,
) {
  return {
    name: p.name,
    category,
    description: p.description ?? '',
    imageFileIds: [...imageFileIds],
    ...(sizeChartFileId && { sizeChartFileId }),
    variants: variants.filter((v) => !v.archivedAt).map((v) => v.sku),
  };
}

/** Id tệp ảnh đang gắn, theo thứ tự (cho nhật ký). Gọi trong `withCompany`. */
async function imageIdsOf(productId: string): Promise<string[]> {
  return (await productImageRows([productId])).map((r) => r.fileId);
}

function race(err: unknown): never {
  const { code, constraint } = pgError(err);
  if (code === '23505' && constraint?.startsWith('products_')) throw taken();
  // Danh mục hay giá trị vừa bị xoá giữa lúc đọc và lúc ghi.
  if (code === '23503' && constraint?.startsWith('products_category_id')) throw invalid({ categoryId: 'Danh mục vừa bị xoá' });
  if (code === '23503') throw invalid({ variants: 'Có giá trị thuộc tính vừa bị xoá' });
  throw err;
}

export async function listProducts(companyId: string, filter: ProductFilter) {
  return withCompany(companyId, async () => {
    const { rows, total } = await findPage(filter);
    // Một câu lấy link ảnh đại diện cho cả trang, không N+1.
    const urls = await publicFileUrls(rows.flatMap((p) => (p.thumbnailFileId ? [p.thumbnailFileId] : [])));
    const items = rows.map((p) => toListItem(p, p.thumbnailFileId ? (urls.get(p.thumbnailFileId) ?? null) : null));
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
export async function createProduct(ctx: CatalogContext, caller: Caller, input: CreateProductInput) {
  const imageIds = input.imageFileIds ?? [];
  const sizeChartId = input.sizeChartFileId ?? null;
  await confirmUploads(caller.companyId, sizeChartId ? [...imageIds, sizeChartId] : imageIds);
  return withCompany(caller.companyId, async () => {
    await lockVariants(caller.companyId);
    // Khoá ngoại kiểm bằng quyền chủ bảng, bỏ qua RLS: phải đọc danh mục dưới công ty mình trước (ground-truth #12).
    const [category] = isUuid(input.categoryId) ? await findCategories(input.categoryId) : [];
    const resolved = await resolveCombos(input.variants.map((v) => v.attributeValueIds));
    const imageError = await fileProblem(imageIds, 'product_image', MAX_PRODUCT_IMAGES);
    const errors: Record<string, string> = {};
    if (!category) errors.categoryId = 'Chọn danh mục';
    if (!resolved.ok) errors.variants = resolved.message;
    if (imageError) errors.images = imageError;
    const sizeChartError = sizeChartId ? await fileProblem([sizeChartId], 'product_image', 1) : null;
    if (sizeChartError) errors.sizeChart = sizeChartError;
    if (!category || !resolved.ok || imageError || sizeChartError) throw invalid(errors);
    if (await productNameExists(input.name)) throw taken();

    const id = await insertProduct(caller.companyId, category.id, input.name, input.description);
    const skus = await allocateSkus(category, resolved.combos);
    for (const [i, combo] of resolved.combos.entries()) {
      await insertVariant(caller.companyId, id, skus[i]!, combo.map((v) => v.id), i);
    }
    await replaceProductImages(caller.companyId, id, imageIds);
    if (sizeChartId) await setSizeChart(id, sizeChartId);
    const result = await productDetail(ctx, await findOwnProduct(id));
    await recordAudit({
      ...auditOf(caller, 'create', ENTITY, id),
      after: snapshot(input, category.name, result.variants, imageIds, sizeChartId),
    });
    return result;
  }).catch(race);
}

/**
 * Sản phẩm đã lưu trữ báo `product_archived` trước `version_conflict` (AC-12 "mọi PUT", plan B2). Dùng cả khi
 * kiểm trước lúc ghi lẫn khi ghi có điều kiện `version` không trúng (người khác vừa sửa, lưu trữ).
 */
async function rejectStale(ctx: CatalogContext, product: ProductRow): Promise<never> {
  if (product.archivedAt) throw productArchived();
  throw versionConflict(`Sản phẩm "${product.name}" vừa được người khác sửa`, await productDetail(ctx, product));
}

async function editable(ctx: CatalogContext, id: string, version: number): Promise<ProductRow> {
  const product = await findOwnProduct(id);
  if (product.archivedAt || product.version !== version) await rejectStale(ctx, product);
  return product;
}

/** Ảnh như `createProduct`; không gửi `imageFileIds` thì giữ nguyên, gửi thì thay toàn bộ sau khi ghi trúng `version`. */
export async function updateProduct(ctx: CatalogContext, caller: Caller, id: string, input: UpdateProductInput) {
  const imageIds = input.imageFileIds;
  const sizeChartId = input.sizeChartFileId;
  const toConfirm = [...(imageIds ?? []), ...(sizeChartId ? [sizeChartId] : [])];
  if (toConfirm.length) await confirmUploads(caller.companyId, toConfirm);
  return withCompany(caller.companyId, async () => {
    const product = await editable(ctx, id, input.version);
    const errors: Record<string, string> = {};
    if (imageIds) {
      const imageError = await fileProblem(imageIds, 'product_image', MAX_PRODUCT_IMAGES);
      if (imageError) errors.images = imageError;
    }
    if (sizeChartId) {
      const sizeChartError = await fileProblem([sizeChartId], 'product_image', 1);
      if (sizeChartError) errors.sizeChart = sizeChartError;
    }
    if (Object.keys(errors).length) throw invalid(errors);
    if (await productNameExists(input.name, id)) throw taken();
    const imagesBefore = await imageIdsOf(id);
    if (!(await updateProductIfVersion(id, input.version, input.name, input.description))) {
      await rejectStale(ctx, await findOwnProduct(id));
    }
    if (imageIds) await replaceProductImages(caller.companyId, id, imageIds);
    if (sizeChartId !== undefined) await setSizeChart(id, sizeChartId);
    const sizeChartAfter = sizeChartId === undefined ? product.sizeChartFileId : sizeChartId;
    const variants = await findVariants({ productId: id });
    await recordAudit({
      ...auditOf(caller, 'update', ENTITY, id),
      before: snapshot(product, product.categoryName, variants, imagesBefore, product.sizeChartFileId),
      after: snapshot(input, product.categoryName, variants, imageIds ?? imagesBefore, sizeChartAfter),
    });
    return productDetail(ctx, await findOwnProduct(id), variants);
  }).catch(race);
}

/**
 * Xoá là lưu trữ (P5). `product_has_active_orders` chưa kiểm: đơn hàng là #24 (D9), khi đó nhận hàm kiểm qua `ctx`
 * như giá chuẩn (catalog không import sales).
 */
export async function archiveProduct(ctx: CatalogContext, caller: Caller, id: string, version: number): Promise<void> {
  await withCompany(caller.companyId, async () => {
    // Cùng khoá với thêm biến thể: không để biến thể được thêm vào sản phẩm vừa lưu trữ (B2, B5).
    await lockVariants(caller.companyId);
    const product = await editable(ctx, id, version);
    if (!(await archiveProductIfVersion(id, version))) await rejectStale(ctx, await findOwnProduct(id));
    await recordAudit({
      ...auditOf(caller, 'delete', ENTITY, id),
      before: snapshot(product, product.categoryName, await findVariants({ productId: id }), await imageIdsOf(id), product.sizeChartFileId),
    });
  });
}
