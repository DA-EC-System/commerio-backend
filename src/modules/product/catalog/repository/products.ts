import { and, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import {
  categories,
  productAttributeValueImages,
  productChannelSpecs,
  productImages,
  products,
  productVariants,
  variantAttributeValues,
} from './schema.ts';

// Mọi hàm chạy trong `withCompany` của service.

const columns = {
  id: products.id,
  name: products.name,
  code: products.code,
  description: products.description,
  sizeChartFileId: products.sizeChartFileId,
  imageAttributeId: products.imageAttributeId,
  originCountry: products.originCountry,
  brand: products.brand,
  categoryId: products.categoryId,
  categoryName: categories.name,
  updatedAt: products.updatedAt,
  version: products.version,
  // SQL có bí danh: cột trong `sql` của Drizzle không kèm tên bảng.
  /** Tệp của ảnh đại diện (`position` 0, #303); null khi chưa có ảnh. Một câu cho cả trang danh sách. */
  thumbnailFileId: sql<string | null>`(select pi.file_id from product.product_images pi
    where pi.product_id = products.id and pi.position = 0)`,
};

export type ProductRow = NonNullable<Awaited<ReturnType<typeof findProduct>>>;

export async function findProduct(id: string) {
  const [row] = await getDb()
    .select(columns)
    .from(products)
    .innerJoin(categories, eq(categories.id, products.categoryId))
    .where(eq(products.id, id));
  return row;
}

export interface ProductFilter {
  search?: string | undefined;
  categoryId?: string | undefined;
  status: 'active' | 'archived';
  /** Có ít nhất một SKU ở trạng thái này (#204). */
  businessStatus?: 'selling' | 'paused' | 'discontinued' | undefined;
  page: number;
  pageSize: number;
}

/** Còn SKU chưa lưu trữ (#204: trạng thái cha suy từ SKU, `Documents/21` §17.1). */
const hasLiveVariant = sql`exists (select 1 from product.product_variants pv
  where pv.product_id = products.id and pv.archived_at is null)`;

/**
 * Tên hoặc SKU của mọi biến thể (kể cả đã lưu trữ) chứa `search`, không phân biệt hoa thường, không ký tự đại diện.
 * `active`: còn SKU chưa lưu trữ; `archived`: mọi SKU đã lưu trữ.
 */
export async function listProducts(filter: ProductFilter) {
  const where = and(
    filter.status === 'archived' ? sql`not ${hasLiveVariant}` : hasLiveVariant,
    filter.categoryId ? eq(products.categoryId, filter.categoryId) : undefined,
    filter.businessStatus
      ? sql`exists (select 1 from product.product_variants pv
          where pv.product_id = products.id and pv.business_status = ${filter.businessStatus})`
      : undefined,
    filter.search
      ? sql`(strpos(lower(${products.name}), lower(${filter.search})) > 0 or exists (
          select 1 from product.product_variants pv
          where pv.product_id = products.id and strpos(lower(pv.sku), lower(${filter.search})) > 0))`
      : undefined,
  );
  // Tuần tự: hai câu cùng một client của giao dịch, pg không cho chạy chồng.
  const rows = await getDb()
    .select(columns)
    .from(products)
    .innerJoin(categories, eq(categories.id, products.categoryId))
    .where(where)
    .orderBy(desc(products.updatedAt), products.id)
    .limit(filter.pageSize)
    .offset((filter.page - 1) * filter.pageSize);
  const [count] = await getDb().select({ total: sql<number>`count(*)::int` }).from(products).where(where);
  return { rows, total: count!.total };
}

/** Sản phẩm cùng tên (chữ thường), xét mọi sản phẩm kể cả mọi SKU đã lưu trữ (#204 D4). */
export async function productNameExists(name: string, exceptId?: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: products.id })
    .from(products)
    .where(and(sql`lower(${products.name}) = lower(${name})`, exceptId ? ne(products.id, exceptId) : undefined));
  return rows.length > 0;
}

/** Mã cha đã có trong công ty (#204 D5). */
export async function productCodeTaken(code: string): Promise<boolean> {
  const rows = await getDb().select({ id: products.id }).from(products).where(eq(products.code, code));
  return rows.length > 0;
}

export async function insertProduct(companyId: string, categoryId: string, name: string, description: string, code: string) {
  const [row] = await getDb()
    .insert(products)
    .values({ companyId, categoryId, name, description, code })
    .returning({ id: products.id });
  return row!.id;
}

const current = (id: string, version: number) => and(eq(products.id, id), eq(products.version, version));

/** Trường của sản phẩm ghi cùng câu (#340); khoá vắng mặt thì giữ nguyên. */
export type ProductExtras = Partial<{ imageAttributeId: string | null; originCountry: string | null; brand: string | null }>;

export async function updateProductIfVersion(id: string, version: number, name: string, description: string, extras: ProductExtras = {}) {
  const rows = await getDb()
    .update(products)
    .set({ name, description, ...extras, version: sql`${products.version} + 1`, updatedAt: sql`now()` })
    .where(current(id, version))
    .returning({ id: products.id });
  return rows.length > 0;
}

/** Thêm, ngừng bán biến thể: đổi `updated_at` nhưng không đổi `version` (P7). */
export async function touchProduct(id: string): Promise<void> {
  await getDb().update(products).set({ updatedAt: sql`now()` }).where(eq(products.id, id));
}

/** Khoá dòng sản phẩm, trả `version` (không có thì `undefined`). */
export async function lockProduct(id: string): Promise<number | undefined> {
  const [row] = await getDb().select({ version: products.version }).from(products).where(eq(products.id, id)).for('update');
  return row?.version;
}

/** Xoá hẳn sản phẩm (#204): con trước cha theo khoá ngoại. Ảnh chỉ gỡ khỏi sản phẩm, tệp giữ nguyên. */
export async function deleteProductTree(productId: string, variantIds: readonly string[]): Promise<void> {
  if (variantIds.length) await getDb().delete(variantAttributeValues).where(inArray(variantAttributeValues.variantId, [...variantIds]));
  await getDb().delete(productImages).where(eq(productImages.productId, productId));
  await getDb().delete(productAttributeValueImages).where(eq(productAttributeValueImages.productId, productId));
  await getDb().delete(productChannelSpecs).where(eq(productChannelSpecs.productId, productId));
  await getDb().delete(productVariants).where(eq(productVariants.productId, productId));
  await getDb().delete(products).where(eq(products.id, productId));
}

/** Đặt hoặc gỡ (`null`) ảnh bảng kích cỡ; gỡ không xoá tệp. Bên gọi đã ghi trúng `version` của sản phẩm. */
export async function setSizeChart(id: string, fileId: string | null): Promise<void> {
  await getDb().update(products).set({ sizeChartFileId: fileId }).where(eq(products.id, id));
}

/** Tệp bảng kích cỡ của các sản phẩm; sản phẩm chưa có thì không có trong kết quả. */
export async function sizeChartRows(productIds: readonly string[]): Promise<{ productId: string; fileId: string }[]> {
  if (!productIds.length) return [];
  const rows = await getDb()
    .select({ productId: products.id, fileId: products.sizeChartFileId })
    .from(products)
    .where(and(inArray(products.id, [...productIds]), isNotNull(products.sizeChartFileId)));
  return rows.map((r) => ({ productId: r.productId, fileId: r.fileId! }));
}
