// Spec sàn của sản phẩm cha (#400, Documents/21 §18.5, Documents/19 mục 3.3). Chạy trong `withCompany` của bên gọi (RLS).
import { and, eq, inArray, max, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import type { CategoryPermission } from '../domain/product-spec.ts';
import { type Marketplace, productSpecs, shopCategoryPermissions } from './schema.ts';

export type ProductSpecRow = typeof productSpecs.$inferSelect;

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export async function findSpec(productId: string, platform: Marketplace): Promise<ProductSpecRow | undefined> {
  if (!isUuid(productId)) return undefined;
  const [row] = await getDb()
    .select()
    .from(productSpecs)
    .where(and(eq(productSpecs.productId, productId), eq(productSpecs.platform, platform)));
  return row;
}

/** Spec của nhiều sản phẩm trên một sàn, một câu (request đẩy, bảng listing). */
export async function specsOf(productIds: readonly string[], platform: Marketplace): Promise<Map<string, ProductSpecRow>> {
  const ids = [...new Set(productIds)].filter(isUuid);
  if (!ids.length) return new Map();
  const rows = await getDb()
    .select()
    .from(productSpecs)
    .where(and(inArray(productSpecs.productId, ids), eq(productSpecs.platform, platform)));
  return new Map(rows.map((r) => [r.productId, r]));
}

export type SpecValues = Pick<ProductSpecRow, 'externalCategoryId' | 'attributes' | 'axisMap' | 'valueMap'>;

/** Tạo spec (`PUT` lần đầu: `version = 1`; bản chép: `version = 0`). Đã có dòng thì `undefined`. */
export async function insertSpec(
  values: SpecValues & { companyId: string; productId: string; platform: Marketplace; source: ProductSpecRow['source']; version: number },
): Promise<ProductSpecRow | undefined> {
  const [row] = await getDb()
    .insert(productSpecs)
    .values({ ...values, categoryStatus: 'ok' })
    .onConflictDoNothing()
    .returning();
  return row;
}

/** Sửa khi còn đúng `version`; `PUT` luôn đặt `source = 'push'`, `categoryStatus = 'ok'`. Không trúng dòng thì `undefined`. */
export async function updateSpec(
  productId: string,
  platform: Marketplace,
  version: number,
  patch: SpecValues & Partial<Pick<ProductSpecRow, 'source' | 'categoryStatus'>>,
  opts: { keepVersion?: boolean } = {},
): Promise<ProductSpecRow | undefined> {
  const [row] = await getDb()
    .update(productSpecs)
    .set({ ...patch, ...(!opts.keepVersion && { version: sql`${productSpecs.version} + 1` }), updatedAt: sql`now()` })
    .where(and(eq(productSpecs.productId, productId), eq(productSpecs.platform, platform), eq(productSpecs.version, version)))
    .returning();
  return row;
}

/**
 * Bản chép (`version = 0`) của các sản phẩm thuộc một danh mục Commerio cập nhật theo ghép danh mục vừa lưu (A18: route cũ
 * trong khe BE2–BE3). Spec đã lưu qua route mới (`version ≥ 1`) không bị đè.
 */
export async function refreshCopiedSpecs(
  productIds: readonly string[],
  platform: Marketplace,
  values: Pick<ProductSpecRow, 'externalCategoryId' | 'attributes'>,
): Promise<number> {
  const ids = productIds.filter(isUuid);
  if (!ids.length) return 0;
  const rows = await getDb()
    .update(productSpecs)
    .set({ ...values, categoryStatus: 'ok', updatedAt: sql`now()` })
    .where(and(inArray(productSpecs.productId, ids), eq(productSpecs.platform, platform), eq(productSpecs.version, 0)))
    .returning({ id: productSpecs.id });
  return rows.length;
}

/** Ghi category của sàn đọc được lên spec (đồng bộ thấy category đổi): chỉ đổi trạng thái, không tăng `version`. */
export async function markSpecCategory(
  productId: string,
  platform: Marketplace,
  fromCategory: string,
  status: ProductSpecRow['categoryStatus'],
): Promise<boolean> {
  const rows = await getDb()
    .update(productSpecs)
    .set({ categoryStatus: status, updatedAt: sql`now()` })
    .where(
      and(eq(productSpecs.productId, productId), eq(productSpecs.platform, platform), eq(productSpecs.externalCategoryId, fromCategory)),
    )
    .returning({ id: productSpecs.id });
  return rows.length > 0;
}

/** Quyền category đã ghi của một gian hàng (TikTok, A17), theo leaf. Gọi trong `withCompany`. */
export async function permissionsOf(
  shopId: string,
  externalCategoryIds: readonly string[],
): Promise<Map<string, { status: CategoryPermission; checkedAt: Date }>> {
  if (!externalCategoryIds.length) return new Map();
  const rows = await getDb()
    .select()
    .from(shopCategoryPermissions)
    .where(and(eq(shopCategoryPermissions.shopId, shopId), inArray(shopCategoryPermissions.externalCategoryId, [...new Set(externalCategoryIds)])));
  return new Map(rows.map((r) => [r.externalCategoryId, { status: r.status, checkedAt: r.checkedAt }]));
}

/**
 * Lần đọc cây gần nhất ghi quyền cho gian hàng (`max(checked_at)`; `upsertPermissions` ghi mọi leaf cùng một mốc), null khi chưa
 * có dòng nào. Gọi trong `withCompany`.
 */
export async function lastPermissionCheck(shopId: string): Promise<Date | null> {
  const [row] = await getDb()
    .select({ at: max(shopCategoryPermissions.checkedAt) })
    .from(shopCategoryPermissions)
    .where(eq(shopCategoryPermissions.shopId, shopId));
  return row?.at ? new Date(row.at) : null;
}

/**
 * Ghi quyền mọi leaf của một gian hàng bằng một câu upsert theo lô (A17). Mã leaf, quyền đi trong một tham số JSON (không tự
 * dựng literal mảng, review BE2 P2-9). Gọi trong `withCompany`.
 */
export async function upsertPermissions(
  companyId: string,
  shopId: string,
  items: readonly { externalCategoryId: string; status: CategoryPermission }[],
  checkedAt: Date,
): Promise<void> {
  if (!items.length) return;
  await getDb().execute(sql`
    insert into channel.shop_category_permissions (company_id, shop_id, external_category_id, status, checked_at)
    select ${companyId}::uuid, ${shopId}::uuid, t.c, t.s, ${checkedAt.toISOString()}::timestamptz
    from jsonb_to_recordset(${JSON.stringify(items.map((i) => ({ c: i.externalCategoryId, s: i.status })))}::jsonb) as t(c text, s text)
    on conflict (shop_id, external_category_id) do update set status = excluded.status, checked_at = excluded.checked_at`);
}
