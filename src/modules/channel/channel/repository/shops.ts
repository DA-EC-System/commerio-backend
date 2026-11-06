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

/**
 * Như `findShopRow` nhưng khoá dòng tới hết giao dịch: ngắt gian hàng (#207). `NO KEY UPDATE` đủ chặn `FOR SHARE` của
 * `lockShopForOrders`, không chặn các lệnh chèn có khoá ngoại tới gian hàng (`listings`, `raw_orders`).
 */
export async function lockShopRow(id: string): Promise<ShopRow | undefined> {
  const [row] = await getDb().select().from(shops).where(eq(shops.id, id)).for('no key update');
  return row;
}

/**
 * Trạng thái gian hàng, khoá chia sẻ tới hết giao dịch nhận đơn (#207): đơn đang chèn thì ngắt (`lockShopRow`) chờ rồi
 * đếm thấy; ngắt đã khoá trước thì bên nhận chờ rồi thấy `disconnected`.
 */
export async function lockShopForOrders(id: string): Promise<{ status: ShopStatus; openingStocktakeId: string | null } | undefined> {
  const [row] = await getDb()
    .select({ status: shops.status, openingStocktakeId: shops.openingStocktakeId })
    .from(shops)
    .where(eq(shops.id, id))
    .for('share');
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
 * Gian hàng đang hoạt động **của mọi công ty**, cho việc nền (kéo quyết toán #117, dựng lại lịch #102): gọi ngoài `withCompany` (role chủ
 * bảng), mỗi gian hàng xử lý tiếp trong `withCompany` của nó.
 */
export async function findActiveShopsAnyCompany(): Promise<
  { id: string; companyId: string; platform: Platform; orderCutoffAt: Date | null; openOrdersPulledAt: Date | null }[]
> {
  return getDb()
    .select({
      id: shops.id,
      companyId: shops.companyId,
      platform: shops.platform,
      orderCutoffAt: shops.orderCutoffAt,
      openOrdersPulledAt: shops.openOrdersPulledAt,
    })
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

/**
 * Gian hàng khác của công ty (RLS lọc công ty): đã có gian hàng xong thiết lập chưa (có mốc, không chờ kiểm kê; kể cả đã
 * ngắt), và phiếu kiểm kê đầu kỳ đang chờ nếu có (#198 A1, A12).
 */
export async function setupStateOfCompany(exceptShopId: string): Promise<{ hasSetUpShop: boolean; awaitingStocktake: string | null }> {
  const rows = await getDb()
    .select({ cutoff: shops.orderCutoffAt, stocktake: shops.openingStocktakeNumber })
    .from(shops)
    .where(and(ne(shops.id, exceptShopId), sql`${shops.orderCutoffAt} is not null`));
  return {
    hasSetUpShop: rows.some((r) => r.stocktake === null),
    awaitingStocktake: rows.find((r) => r.stocktake !== null)?.stocktake ?? null,
  };
}

/** Đánh dấu lượt đẩy tồn đầu tiên sau thiết lập đã chạy (§18.7.7 `push_stock`). Không tăng `version`. */
export async function markStockPushed(id: string): Promise<void> {
  await getDb()
    .update(shops)
    .set({ stockPushedAt: sql`now()` })
    .where(and(eq(shops.id, id), sql`${shops.stockPushedAt} is null`));
}

/** Lỗi lượt kéo đơn còn mở ghi vào `last_error` bắt đầu bằng câu này; lượt xong thì xoá đúng lỗi đó (#198 P3). */
export const OPEN_ORDER_PULL_ERROR = 'Lượt kéo đơn còn mở chưa xong';

/** Lượt kéo đơn còn mở xong (#198 A10): từ giờ `syncListings` mới đẩy tồn. Không tăng `version`. */
export async function markOpenOrdersPulled(id: string): Promise<void> {
  await getDb()
    .update(shops)
    .set({
      openOrdersPulledAt: sql`coalesce(${shops.openOrdersPulledAt}, now())`,
      lastError: sql`case when ${shops.lastError} like ${`${OPEN_ORDER_PULL_ERROR}%`} then null else ${shops.lastError} end`,
    })
    .where(eq(shops.id, id));
}

/** Ghi lỗi của lượt kéo đơn còn mở để người dùng thấy gian hàng chưa đẩy tồn (#198 P3). Không tăng `version`. */
export async function recordOpenOrderPullError(id: string, message: string): Promise<void> {
  await getDb()
    .update(shops)
    .set({ lastError: `${OPEN_ORDER_PULL_ERROR}: ${message}` })
    .where(and(eq(shops.id, id), sql`${shops.openOrdersPulledAt} is null`));
}

/** Công ty đang chọn đã từng nối gian hàng chưa (kể cả đã ngắt): có thì không tắt được phân hệ Kênh bán (#152). */
export async function hasChannelData(): Promise<boolean> {
  const [row] = await getDb().select({ one: sql`1` }).from(shops).limit(1);
  return !!row;
}
