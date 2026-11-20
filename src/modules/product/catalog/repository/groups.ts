import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { productGroups, products } from './schema.ts';

// Mọi hàm chạy trong `withCompany` của service: RLS chỉ cho thấy dòng của công ty đang chọn.
// Subquery viết SQL có bí danh: Drizzle in cột không kèm tên bảng khi chỉ select một bảng, `id` sẽ nhập nhằng.

const columns = {
  id: productGroups.id,
  name: productGroups.name,
  marginCoefficient: productGroups.marginCoefficient,
  priceRounding: productGroups.priceRounding,
  reorderLeadDays: productGroups.reorderLeadDays,
  reorderSafetyQty: productGroups.reorderSafetyQty,
  reorderDefaultQty: productGroups.reorderDefaultQty,
  version: productGroups.version,
  updatedAt: productGroups.updatedAt,
  // Đếm cả sản phẩm đã lưu trữ: cùng điều kiện với `in_use` khi xoá (V25).
  productCount: sql<number>`(select count(*)::int from product.products p where p.group_id = product_groups.id)`,
  // Mẫu thông số (#510, Documents/21 mục 5.5).
  specFieldCount: sql<number>`(select count(*)::int from product.group_spec_fields g where g.group_id = product_groups.id)`,
  requiredCount: sql<number>`(select count(*)::int from product.group_spec_fields g where g.group_id = product_groups.id and g.required)`,
};

export type GroupRow = Awaited<ReturnType<typeof findGroups>>[number];

export function findGroups(id?: string) {
  return getDb()
    .select(columns)
    .from(productGroups)
    .where(id ? eq(productGroups.id, id) : undefined);
}

export async function groupNameExists(name: string, exceptId?: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: productGroups.id })
    .from(productGroups)
    .where(and(sql`lower(${productGroups.name}) = lower(${name})`, exceptId ? ne(productGroups.id, exceptId) : undefined));
  return rows.length > 0;
}

/** Cấu hình gợi ý dạng cột (#242); hệ số là chuỗi `numeric`. Dùng chung cho nhóm hàng và cài đặt công ty. */
export interface SuggestColumns {
  marginCoefficient: string | null;
  priceRounding: number | null;
  reorderLeadDays: number | null;
  reorderSafetyQty: number | null;
  reorderDefaultQty: number | null;
}

export async function insertGroup(companyId: string, name: string, suggest: SuggestColumns): Promise<string> {
  const [row] = await getDb().insert(productGroups).values({ companyId, name, ...suggest }).returning({ id: productGroups.id });
  return row!.id;
}

/** Ghi có điều kiện version; `false` khi người khác vừa sửa hoặc xoá. */
export async function updateGroupIfVersion(id: string, version: number, name: string, suggest: SuggestColumns) {
  const rows = await getDb()
    .update(productGroups)
    .set({ name, ...suggest, version: sql`${productGroups.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(productGroups.id, id), eq(productGroups.version, version)))
    .returning({ id: productGroups.id });
  return rows.length > 0;
}

export async function deleteGroupIfVersion(id: string, version: number) {
  const rows = await getDb()
    .delete(productGroups)
    .where(and(eq(productGroups.id, id), eq(productGroups.version, version)))
    .returning({ id: productGroups.id });
  return rows.length > 0;
}

/** Sản phẩm của nhóm (kể cả đã lưu trữ), khoá dòng để chuyển; `ids` thì chỉ trong số đó. */
export function lockGroupProducts(groupId: string, ids?: readonly string[]) {
  return getDb()
    .select({ id: products.id, name: products.name })
    .from(products)
    .where(and(eq(products.groupId, groupId), ids ? inArray(products.id, [...ids]) : undefined))
    .for('update');
}

/** Đổi nhóm của sản phẩm, tăng `version` sản phẩm; không đụng `version` của nhóm (21 mục 5.2). */
export async function setProductsGroup(ids: readonly string[], groupId: string): Promise<void> {
  if (ids.length === 0) return;
  await getDb()
    .update(products)
    .set({ groupId, version: sql`${products.version} + 1`, updatedAt: sql`now()` })
    .where(inArray(products.id, [...ids]));
}
