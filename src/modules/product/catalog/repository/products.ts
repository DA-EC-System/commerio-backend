import { and, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import {
  productGroups,
  productAttributeValueImages,
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
  groupId: products.groupId,
  groupName: productGroups.name,
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
    .innerJoin(productGroups, eq(productGroups.id, products.groupId))
    .where(eq(products.id, id));
  return row;
}

export interface ProductFilter {
  search?: string | undefined;
  groupId?: string | undefined;
  status: 'active' | 'archived';
  /** Có ít nhất một SKU ở trạng thái này (#204). */
  businessStatus?: 'selling' | 'paused' | 'discontinued' | undefined;
  /** Có SKU chưa lưu trữ `incomplete` / mọi SKU chưa lưu trữ `ready` (Documents/21 §17.2). */
  readiness?: 'incomplete' | 'ready' | undefined;
  page: number;
  pageSize: number;
}

/** Còn SKU chưa lưu trữ (#204: trạng thái cha suy từ SKU, `Documents/21` §17.1). */
const hasLiveVariant = sql`exists (select 1 from product.product_variants pv
  where pv.product_id = products.id and pv.archived_at is null)`;

/**
 * Có SKU chưa lưu trữ `incomplete`: cùng luật với `readinessOf` (`domain/labels.ts`; Documents/21 §17.1), viết bằng SQL để
 * lọc trong câu phân trang. Trường của cha (tên, ảnh, ảnh phân loại một phần, thông số bắt buộc trống) làm mọi SKU thiếu;
 * ngưỡng tồn đọc `stock_levels` của inventory (cùng schema `product`, không có dòng là chưa đặt). Đổi luật thì sửa cả hai
 * nơi; test `labels.test.ts` ("lọc readiness") so bộ lọc với `incompleteCount`.
 */
const hasIncompleteVariant = sql`exists (select 1 from product.product_variants pv
  left join product.stock_levels sl on sl.variant_id = pv.id
  where pv.product_id = products.id and pv.archived_at is null and (
    pv.target_net_price is null or sl.min_qty is null or pv.weight_g is null
    or pv.length_mm is null or pv.width_mm is null or pv.height_mm is null
    or btrim(products.name) = ''
    or not exists (select 1 from product.product_images pi where pi.product_id = products.id)
    or exists (select 1 from product.group_spec_fields g
      where g.group_id = products.group_id and g.required
        and not exists (select 1 from product.product_spec_values v where v.product_id = products.id and v.field_id = g.field_id))
    or exists (select 1 from (
      select bool_or(pavi.id is not null) as some_img, bool_and(pavi.id is not null) as all_img
      from product.product_variants pv2
      join product.variant_attribute_values vav on vav.variant_id = pv2.id
      join product.attribute_values av on av.id = vav.attribute_value_id and av.attribute_id = products.image_attribute_id
      left join product.product_attribute_value_images pavi
        on pavi.product_id = pv2.product_id and pavi.attribute_value_id = vav.attribute_value_id
      where pv2.product_id = products.id and pv2.archived_at is null) x
      where x.some_img and not x.all_img)))`;

/**
 * Tên hoặc SKU của mọi biến thể (kể cả đã lưu trữ) chứa `search`, không phân biệt hoa thường, không ký tự đại diện.
 * `active`: còn SKU chưa lưu trữ; `archived`: mọi SKU đã lưu trữ.
 */
export async function listProducts(filter: ProductFilter) {
  const where = and(
    filter.status === 'archived' ? sql`not ${hasLiveVariant}` : hasLiveVariant,
    filter.groupId ? eq(products.groupId, filter.groupId) : undefined,
    filter.businessStatus
      ? sql`exists (select 1 from product.product_variants pv
          where pv.product_id = products.id and pv.business_status = ${filter.businessStatus})`
      : undefined,
    filter.readiness === 'incomplete' ? hasIncompleteVariant : filter.readiness === 'ready' ? sql`not ${hasIncompleteVariant}` : undefined,
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
    .innerJoin(productGroups, eq(productGroups.id, products.groupId))
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

export async function insertProduct(
  companyId: string,
  groupId: string,
  name: string,
  description: string,
  code: string,
  extras: Pick<ProductExtras, 'originCountry' | 'brand' | 'imageAttributeId'> = {},
) {
  const [row] = await getDb()
    .insert(products)
    .values({ companyId, groupId, name, description, code, ...extras })
    .returning({ id: products.id });
  return row!.id;
}

const current = (id: string, version: number) => and(eq(products.id, id), eq(products.version, version));

/** Trường của sản phẩm ghi cùng câu (#340); khoá vắng mặt thì giữ nguyên. */
export type ProductExtras = Partial<{ imageAttributeId: string | null; originCountry: string | null; brand: string | null; groupId: string }>;

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

/** Nhóm hàng của các sản phẩm (đọc qua RLS); sản phẩm không thấy thì vắng mặt. */
export async function productGroupIds(ids: readonly string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await getDb()
    .select({ id: products.id, groupId: products.groupId })
    .from(products)
    .where(inArray(products.id, [...ids]));
  return new Map(rows.map((r) => [r.id, r.groupId]));
}
