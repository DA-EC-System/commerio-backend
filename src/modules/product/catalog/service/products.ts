// Sản phẩm (UC-CP-02, UC-CP-04; Documents/21 5.2–5.4, C3, C5, P5–P8, V22, V24; D9; plan #12 B1, B2, B6).
import { Decimal } from 'decimal.js';
import { withCompany } from '../../../../shared/db/client.ts';
import { confirmUploads, fileProblem, recordAudit } from '../../../core/index.ts';
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
import { imagesOf, MAX_PRODUCT_IMAGES } from './product-images.ts';
import { allocateSkus, resolveCombos } from './sku-allocation.ts';
import { type CatalogContext, standardPricesOf } from './standard-price.ts';

export interface CreateProductInput {
  name: string;
  categoryId: string;
  description: string;
  /** Id tệp ảnh theo thứ tự, ảnh đầu là ảnh đại diện (#303). */
  imageFileIds?: string[] | undefined;
  variants: { attributeValueIds: string[] }[];
}

export interface UpdateProductInput {
  name: string;
  description: string;
  /** Không gửi thì giữ nguyên ảnh; gửi thì thay toàn bộ (`[]` gỡ hết). */
  imageFileIds?: string[] | undefined;
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

export function toVariantView(v: VariantRow, standardPrice: Decimal | null = null) {
  return {
    id: v.id,
    sku: v.sku,
    attributes: v.attributes.map(({ code: _, ...a }) => a),
    archivedAt: v.archivedAt?.toISOString() ?? null,
    // Giá trên API là số nguyên đồng (G1); DB và service giữ Decimal.
    standardPrice: standardPrice === null ? null : standardPrice.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber(),
  };
}

async function detail(ctx: CatalogContext, p: ProductRow, variants?: VariantRow[]) {
  const rows = variants ?? (await findVariants({ productId: p.id }));
  const prices = await standardPricesOf(ctx, rows.map((v) => v.id));
  const images = await imagesOf(p.id);
  return {
    ...toListItem(p, images[0]?.url ?? null),
    description: p.description ?? '',
    images,
    variants: rows.map((v) => toVariantView(v, prices.get(v.id) ?? null)),
  };
}
export type ProductDetail = Awaited<ReturnType<typeof detail>>;

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
) {
  return {
    name: p.name,
    category,
    description: p.description ?? '',
    imageFileIds: [...imageFileIds],
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
    return { items: rows.map((p) => toListItem(p, null)), total, page: filter.page, pageSize: filter.pageSize };
  });
}

export async function getProduct(ctx: CatalogContext, companyId: string, id: string): Promise<ProductDetail> {
  return withCompany(companyId, async () => detail(ctx, await findOwnProduct(id)));
}

/**
 * Ảnh (#303): `confirmUploads` hỏi kho **trước** giao dịch (gọi mạng); trong giao dịch `fileProblem` kiểm tệp của công
 * ty, đúng `product_image`, đã PUT xong. Số ảnh, ảnh lặp đã kiểm ở Zod.
 */
export async function createProduct(ctx: CatalogContext, caller: Caller, input: CreateProductInput) {
  const imageIds = input.imageFileIds ?? [];
  await confirmUploads(caller.companyId, imageIds);
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
    if (!category || !resolved.ok || imageError) throw invalid(errors);
    if (await productNameExists(input.name)) throw taken();

    const id = await insertProduct(caller.companyId, category.id, input.name, input.description);
    const skus = await allocateSkus(category, resolved.combos);
    for (const [i, combo] of resolved.combos.entries()) {
      await insertVariant(caller.companyId, id, skus[i]!, combo.map((v) => v.id), i);
    }
    await replaceProductImages(caller.companyId, id, imageIds);
    const result = await detail(ctx, await findOwnProduct(id));
    await recordAudit({ ...auditOf(caller, 'create', ENTITY, id), after: snapshot(input, category.name, result.variants, imageIds) });
    return result;
  }).catch(race);
}

/**
 * Sản phẩm đã lưu trữ báo `product_archived` trước `version_conflict` (AC-12 "mọi PUT", plan B2). Dùng cả khi
 * kiểm trước lúc ghi lẫn khi ghi có điều kiện `version` không trúng (người khác vừa sửa, lưu trữ).
 */
async function rejectStale(ctx: CatalogContext, product: ProductRow): Promise<never> {
  if (product.archivedAt) throw productArchived();
  throw versionConflict(`Sản phẩm "${product.name}" vừa được người khác sửa`, await detail(ctx, product));
}

async function editable(ctx: CatalogContext, id: string, version: number): Promise<ProductRow> {
  const product = await findOwnProduct(id);
  if (product.archivedAt || product.version !== version) await rejectStale(ctx, product);
  return product;
}

/** Ảnh như `createProduct`; không gửi `imageFileIds` thì giữ nguyên, gửi thì thay toàn bộ sau khi ghi trúng `version`. */
export async function updateProduct(ctx: CatalogContext, caller: Caller, id: string, input: UpdateProductInput) {
  const imageIds = input.imageFileIds;
  if (imageIds) await confirmUploads(caller.companyId, imageIds);
  return withCompany(caller.companyId, async () => {
    const product = await editable(ctx, id, input.version);
    if (imageIds) {
      const imageError = await fileProblem(imageIds, 'product_image', MAX_PRODUCT_IMAGES);
      if (imageError) throw invalid({ images: imageError });
    }
    if (await productNameExists(input.name, id)) throw taken();
    const imagesBefore = await imageIdsOf(id);
    if (!(await updateProductIfVersion(id, input.version, input.name, input.description))) {
      await rejectStale(ctx, await findOwnProduct(id));
    }
    if (imageIds) await replaceProductImages(caller.companyId, id, imageIds);
    const variants = await findVariants({ productId: id });
    await recordAudit({
      ...auditOf(caller, 'update', ENTITY, id),
      before: snapshot(product, product.categoryName, variants, imagesBefore),
      after: snapshot(input, product.categoryName, variants, imageIds ?? imagesBefore),
    });
    return detail(ctx, await findOwnProduct(id), variants);
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
      before: snapshot(product, product.categoryName, await findVariants({ productId: id }), await imageIdsOf(id)),
    });
  });
}
