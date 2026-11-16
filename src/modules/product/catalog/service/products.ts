// Sản phẩm (UC-CP-02, UC-CP-04; Documents/21 5.2–5.4, C3, C5, P5–P8, V22, V24; D9; plan #12 B1, B2, B6).
import { Decimal } from 'decimal.js';
import { withCompany } from '../../../../shared/db/client.ts';
import { confirmUploads, fileProblem, publicFileUrls, recordAudit } from '../../../core/index.ts';
import { countLabels, type LabelledSku } from '../domain/labels.ts';
import { findCategories } from '../repository/categories.ts';
import { productImageRows, replaceProductImages } from '../repository/product-images.ts';
import {
  deleteProductTree,
  findProduct,
  insertProduct,
  listProducts as findPage,
  lockProduct,
  type ProductFilter,
  type ProductRow,
  productNameExists,
  updateProductIfVersion,
} from '../repository/products.ts';
import { findVariants, insertVariant, lockProductVariants, lockVariants, type VariantRow } from '../repository/variants.ts';
import {
  auditOf,
  type Caller,
  invalid,
  isUuid,
  nameTaken,
  notFound,
  pgError,
  productInUse,
  tooManyAxes,
  versionConflict,
} from './errors.ts';
import { type SkuLabels, skuLabels } from './labels.ts';
import { imagesOf, MAX_PRODUCT_IMAGES } from './product-images.ts';
import { allocateSkus, productCodeFor, resolveCombos } from './sku-allocation.ts';
import { type CatalogContext, standardPricesOf } from './standard-price.ts';
import { archiveBlockersOf, inUseOf, requirePort } from './usage.ts';

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
    category: { id: p.categoryId, name: p.categoryName },
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
) {
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
  const labels = await skuLabels(ctx, rows, () => ({ name: p.name, categoryId: p.categoryId, imageCount: images.length }));
  const views = rows.map((v) => toVariantView(v, labels.get(v.id)!, prices.get(v.id) ?? null, blockers.get(v.id)));
  return {
    ...toListItem(p, images[0]?.url ?? null, views),
    description: p.description ?? '',
    images,
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

/**
 * Một trang danh sách với số câu truy vấn cố định (#204 Review Focus 2): trang sản phẩm, SKU của cả trang, ngưỡng tồn,
 * hiện diện, link ảnh đại diện mỗi thứ một lần, không theo số dòng.
 */
export async function listProducts(ctx: CatalogContext, companyId: string, filter: ProductFilter) {
  return withCompany(companyId, async () => {
    const { rows, total } = await findPage(filter);
    const variants = rows.length ? await findVariants({ productIds: rows.map((p) => p.id) }) : [];
    // Độ hoàn thiện chỉ cần cha có ảnh hay không: ảnh `position` 0 có khi và chỉ khi có ảnh.
    const parents = new Map(rows.map((p) => [p.id, { name: p.name, categoryId: p.categoryId, imageCount: p.thumbnailFileId ? 1 : 0 }]));
    const labels = await skuLabels(ctx, variants, (id) => parents.get(id)!);
    const skusOf = Map.groupBy(
      variants.map((v) => ({ productId: v.productId, businessStatus: v.businessStatus, ...labels.get(v.id)! })),
      (s) => s.productId,
    );
    const urls = await publicFileUrls(rows.flatMap((p) => (p.thumbnailFileId ? [p.thumbnailFileId] : [])));
    const items = rows.map((p) =>
      toListItem(p, p.thumbnailFileId ? (urls.get(p.thumbnailFileId) ?? null) : null, skusOf.get(p.id) ?? []),
    );
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
  await confirmUploads(caller.companyId, imageIds);
  return withCompany(caller.companyId, async () => {
    // Tối đa 2 trục (#204): kiểm trước mọi lần đọc, thay lỗi CHECK `variant_attribute_values_position` của DB.
    if (input.variants.some((v) => v.attributeValueIds.length > 2)) throw tooManyAxes();
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

    const skus = await allocateSkus(category, resolved.combos);
    const code = await productCodeFor(category.skuPattern, skus[0]!.seq);
    const id = await insertProduct(caller.companyId, category.id, input.name, input.description, code);
    for (const [i, combo] of resolved.combos.entries()) {
      await insertVariant(caller.companyId, id, skus[i]!.sku, combo.map((v) => v.id), i);
    }
    await replaceProductImages(caller.companyId, id, imageIds);
    const result = await productDetail(ctx, await findOwnProduct(id));
    await recordAudit({
      ...auditOf(caller, 'create', ENTITY, id),
      after: { ...snapshot(input, category.name, result.variants, imageIds), code },
    });
    return result;
  }).catch(race);
}

/** Dùng cả khi kiểm trước lúc ghi lẫn khi ghi có điều kiện `version` không trúng (người khác vừa sửa). */
async function rejectStale(ctx: CatalogContext, product: ProductRow): Promise<never> {
  throw versionConflict(`Sản phẩm "${product.name}" vừa được người khác sửa`, await productDetail(ctx, product));
}

async function editable(ctx: CatalogContext, id: string, version: number): Promise<ProductRow> {
  const product = await findOwnProduct(id);
  if (product.version !== version) await rejectStale(ctx, product);
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
    return productDetail(ctx, await findOwnProduct(id), variants);
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
    const parent = { name: product.name, categoryId: product.categoryId, imageCount: imageIds.length };
    const labels = await skuLabels(ctx, variants, () => parent);
    if (variants.some((v) => labels.get(v.id)!.readiness === 'ready')) {
      throw productInUse('Sản phẩm có SKU đã hoàn thiện, không xoá hẳn được; lưu trữ từng SKU');
    }
    if ((await inUseOf(ctx, ids)).size) throw productInUse('Sản phẩm đã có chứng từ hoặc listing, không xoá hẳn được; lưu trữ từng SKU');
    if (variants.some((v) => v.sourceRequestLineId)) throw productInUse('Sản phẩm sinh từ đề nghị nhập, không xoá hẳn được');
    await requirePort(ctx, 'deleteStockLevels')(ids);
    await deleteProductTree(id, ids);
    await recordAudit({
      ...auditOf(caller, 'delete', ENTITY, id),
      before: { ...snapshot(product, product.categoryName, variants, imageIds), code: product.code },
    });
  });
}
