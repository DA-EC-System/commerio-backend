import { and, eq, ne, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { categories } from './schema.ts';

// Mọi hàm chạy trong `withCompany` của service: RLS chỉ cho thấy dòng của công ty đang chọn.
// Subquery viết SQL có bí danh: Drizzle in cột không kèm tên bảng khi chỉ select một bảng, `id` sẽ nhập nhằng.

const columns = {
  id: categories.id,
  name: categories.name,
  skuPattern: categories.skuPattern,
  skuNextSeq: categories.skuNextSeq,
  version: categories.version,
  updatedAt: categories.updatedAt,
  // Đếm cả sản phẩm đã lưu trữ: cùng điều kiện với `in_use` khi xoá (V25).
  productCount: sql<number>`(select count(*)::int from product.products p where p.category_id = categories.id)`,
};

export type CategoryRow = Awaited<ReturnType<typeof findCategories>>[number];

export function findCategories(id?: string) {
  return getDb()
    .select(columns)
    .from(categories)
    .where(id ? eq(categories.id, id) : undefined);
}

export async function categoryNameExists(name: string, exceptId?: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: categories.id })
    .from(categories)
    .where(and(sql`lower(${categories.name}) = lower(${name})`, exceptId ? ne(categories.id, exceptId) : undefined));
  return rows.length > 0;
}

export async function insertCategory(companyId: string, name: string, skuPattern: string): Promise<string> {
  const [row] = await getDb().insert(categories).values({ companyId, name, skuPattern }).returning({ id: categories.id });
  return row!.id;
}

/** Ghi có điều kiện version; `false` khi người khác vừa sửa hoặc xoá. */
export async function updateCategoryIfVersion(id: string, version: number, name: string, skuPattern: string) {
  const rows = await getDb()
    .update(categories)
    .set({ name, skuPattern, version: sql`${categories.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(categories.id, id), eq(categories.version, version)))
    .returning({ id: categories.id });
  return rows.length > 0;
}

export async function deleteCategoryIfVersion(id: string, version: number) {
  const rows = await getDb()
    .delete(categories)
    .where(and(eq(categories.id, id), eq(categories.version, version)))
    .returning({ id: categories.id });
  return rows.length > 0;
}

/** Số thứ tự kế tiếp sau khi cấp SKU; không đổi `version` (Documents/21 P7). */
export async function setSkuNextSeq(id: string, next: number): Promise<void> {
  await getDb().update(categories).set({ skuNextSeq: next }).where(eq(categories.id, id));
}
