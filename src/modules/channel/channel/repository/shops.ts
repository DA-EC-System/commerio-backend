// Gian hàng (#103). Chạy trong `withCompany` của bên gọi, trừ `findLiveCompanyOf`.
import { and, asc, count, eq, inArray, ne, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import type { ShopStatus } from '../domain/shop.ts';
import { listings, shops } from './schema.ts';

export type ShopRow = typeof shops.$inferSelect;
type Platform = ShopRow['platform'];

/** Listing còn trên sàn: bị gỡ khi ngắt (§18.1) và tính vào `listingCount`. */
const ON_PLATFORM = ['live', 'hidden', 'under_review', 'platform_hold'] as const;

export async function listShopRows(): Promise<ShopRow[]> {
  return getDb().select().from(shops).orderBy(asc(shops.createdAt));
}

export async function findShopRow(id: string): Promise<ShopRow | undefined> {
  const [row] = await getDb().select().from(shops).where(eq(shops.id, id));
  return row;
}

export async function findShopByExternal(platform: Platform, externalShopId: string): Promise<ShopRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(shops)
    .where(and(eq(shops.platform, platform), eq(shops.externalShopId, externalShopId)));
  return row;
}

/**
 * Công ty đang gắn seller này (chưa ngắt), **của mọi công ty**: gọi ngoài `withCompany` (role chủ bảng, RLS không
 * FORCE), chỉ để báo `shop_connected_elsewhere` (#103 B3), như tra mã thanh toán của payment.
 */
export async function findLiveCompanyOf(platform: Platform, externalShopId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ companyId: shops.companyId })
    .from(shops)
    .where(and(eq(shops.platform, platform), eq(shops.externalShopId, externalShopId), ne(shops.status, 'disconnected')));
  return row?.companyId ?? null;
}

/**
 * Gian hàng đang hoạt động **của mọi công ty**, cho việc nền kéo quyết toán (#117): gọi ngoài `withCompany` (role chủ
 * bảng), mỗi gian hàng xử lý tiếp trong `withCompany` của nó.
 */
export async function findActiveShopsAnyCompany(): Promise<{ id: string; companyId: string; platform: Platform }[]> {
  return getDb()
    .select({ id: shops.id, companyId: shops.companyId, platform: shops.platform })
    .from(shops)
    .where(eq(shops.status, 'active'));
}

export async function insertShop(values: typeof shops.$inferInsert): Promise<ShopRow> {
  const [row] = await getDb().insert(shops).values(values).returning();
  return row!;
}

/**
 * Sửa gian hàng khi còn đúng `version` (và đúng trạng thái `from` khi chuyển trạng thái), tăng `version`.
 * Không trúng dòng thì trả `undefined`, bên gọi đọc lại để báo 409.
 */
export async function updateShop(
  id: string,
  expected: { version: number; status?: ShopStatus },
  patch: Partial<typeof shops.$inferInsert>,
): Promise<ShopRow | undefined> {
  const [row] = await getDb()
    .update(shops)
    .set({ ...patch, version: sql`${shops.version} + 1`, updatedAt: sql`now()` })
    .where(
      and(
        eq(shops.id, id),
        eq(shops.version, expected.version),
        expected.status ? eq(shops.status, expected.status) : undefined,
      ),
    )
    .returning();
  return row;
}

/** Số listing còn trên sàn theo gian hàng. */
export async function countListingsOnPlatform(shopIds: readonly string[]): Promise<Map<string, number>> {
  if (shopIds.length === 0) return new Map();
  const rows = await getDb()
    .select({ shopId: listings.shopId, n: count() })
    .from(listings)
    .where(and(inArray(listings.shopId, [...shopIds]), inArray(listings.status, [...ON_PLATFORM])))
    .groupBy(listings.shopId);
  return new Map(rows.map((r) => [r.shopId, r.n]));
}

/**
 * Ngắt gian hàng: listing còn trên sàn chuyển `delisted`, đánh dấu gỡ do ngắt để kết nối lại thì đưa lên (§18.1).
 * Trả trạng thái trước khi gỡ để bên gọi ghi lịch sử. Bên gọi đã khoá dòng gian hàng nên không đua với lần đẩy listing.
 */
export async function delistForDisconnect(shopId: string): Promise<{ id: string; from: string }[]> {
  const before = await getDb()
    .select({ id: listings.id, from: listings.status })
    .from(listings)
    .where(and(eq(listings.shopId, shopId), inArray(listings.status, [...ON_PLATFORM])))
    .for('update');
  if (before.length === 0) return [];
  await getDb()
    .update(listings)
    .set({
      status: 'delisted',
      hiddenBy: null,
      delistedByDisconnect: true,
      version: sql`${listings.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      inArray(
        listings.id,
        before.map((r) => r.id),
      ),
    );
  return before;
}
