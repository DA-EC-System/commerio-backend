import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { companyGroupSettings, productGroups, products } from './schema.ts';

// Mọi hàm chạy trong `withCompany` của service: RLS cho thấy nhóm nền tảng và nhóm của công ty đang chọn.
// Nhóm nền tảng lấy gợi ý, cờ ẩn, `version` từ `company_group_settings` của công ty (chưa có dòng: trống, 0); nối kèm
// điều kiện công ty tường minh để đúng cả khi chạy bằng role chủ bảng.
// Subquery viết SQL có bí danh: Drizzle in cột không kèm tên bảng khi chỉ select một bảng, `id` sẽ nhập nhằng.

const CURRENT_COMPANY = sql`nullif(current_setting('app.company_id', true), '')::uuid`;
export const settingsJoin = and(eq(companyGroupSettings.groupId, productGroups.id), sql`${companyGroupSettings.companyId} = ${CURRENT_COMPANY}`);
const platform = sql`${productGroups.companyId} is null`;
const effective = <T>(col: unknown, own: unknown) => sql<T>`case when ${platform} then ${col} else ${own} end`;

/** Gợi ý hiệu lực của nhóm (nhóm nền tảng: của công ty ở `company_group_settings`); cần `leftJoin(companyGroupSettings, settingsJoin)`. */
export const effectiveSuggest = {
  marginCoefficient: effective<string | null>(companyGroupSettings.marginCoefficient, productGroups.marginCoefficient),
  priceRounding: effective<number | null>(companyGroupSettings.priceRounding, productGroups.priceRounding),
  reorderLeadDays: effective<number | null>(companyGroupSettings.reorderLeadDays, productGroups.reorderLeadDays),
  reorderSafetyQty: effective<number | null>(companyGroupSettings.reorderSafetyQty, productGroups.reorderSafetyQty),
  reorderDefaultQty: effective<number | null>(companyGroupSettings.reorderDefaultQty, productGroups.reorderDefaultQty),
};

const columns = {
  id: productGroups.id,
  companyId: productGroups.companyId,
  name: productGroups.name,
  ...effectiveSuggest,
  hidden: sql<boolean>`coalesce(${companyGroupSettings.hidden}, false)`,
  version: sql<number>`case when ${platform} then coalesce(${companyGroupSettings.version}, 0) else ${productGroups.version} end`,
  updatedAt: sql<Date>`case when ${platform} then coalesce(${companyGroupSettings.updatedAt}, ${productGroups.updatedAt}) else ${productGroups.updatedAt} end`.mapWith(
    (v: string | Date) => new Date(v),
  ),
  // Đếm cả sản phẩm đã lưu trữ: cùng điều kiện với `in_use` khi xoá (V25).
  productCount: sql<number>`(select count(*)::int from product.products p where p.group_id = product_groups.id)`,
  // Mẫu thông số (#510, Documents/21 mục 5.5).
  specFieldCount: sql<number>`(select count(*)::int from product.group_spec_fields g where g.group_id = product_groups.id)`,
  requiredCount: sql<number>`(select count(*)::int from product.group_spec_fields g where g.group_id = product_groups.id and g.required)`,
};

export type GroupRow = Awaited<ReturnType<typeof findGroups>>[number];

/** `includeHidden: false` bỏ nhóm nền tảng công ty đã ẩn (ô chọn nhóm); đọc theo id luôn thấy. */
export function findGroups(id?: string, opts: { includeHidden?: boolean } = {}) {
  return getDb()
    .select(columns)
    .from(productGroups)
    .leftJoin(companyGroupSettings, settingsJoin)
    .where(
      and(
        id ? eq(productGroups.id, id) : undefined,
        opts.includeHidden === false ? sql`coalesce(${companyGroupSettings.hidden}, false) = false` : undefined,
      ),
    );
}

/** Ẩn hoặc hiện nhóm nền tảng cho công ty (không điều kiện `version`, Documents/21 mục 5.5); tăng `version` cài đặt. */
export async function setGroupHidden(companyId: string, groupId: string, hidden: boolean): Promise<void> {
  await getDb()
    .insert(companyGroupSettings)
    .values({ companyId, groupId, hidden })
    .onConflictDoUpdate({
      target: [companyGroupSettings.companyId, companyGroupSettings.groupId],
      set: { hidden, version: sql`${companyGroupSettings.version} + 1`, updatedAt: sql`now()` },
    });
}

/**
 * Ghi cài đặt của công ty trên nhóm nền tảng, có điều kiện `version` (0 = chưa có dòng). `false` khi người khác vừa
 * ghi. `patch` bỏ trường là giữ.
 */
export async function upsertGroupSettingsIfVersion(
  companyId: string,
  groupId: string,
  version: number,
  patch: Partial<SuggestColumns & { hidden: boolean }>,
): Promise<boolean> {
  if (version === 0) {
    const rows = await getDb()
      .insert(companyGroupSettings)
      .values({ companyId, groupId, ...patch })
      .onConflictDoNothing()
      .returning({ groupId: companyGroupSettings.groupId });
    return rows.length > 0;
  }
  const rows = await getDb()
    .update(companyGroupSettings)
    .set({ ...patch, version: sql`${companyGroupSettings.version} + 1`, updatedAt: sql`now()` })
    .where(
      and(eq(companyGroupSettings.companyId, companyId), eq(companyGroupSettings.groupId, groupId), eq(companyGroupSettings.version, version)),
    )
    .returning({ groupId: companyGroupSettings.groupId });
  return rows.length > 0;
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
