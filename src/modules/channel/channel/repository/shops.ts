// Gian hàng (#103). Chạy trong `withCompany` của bên gọi, trừ `findLiveCompanyOf`.
import { and, asc, count, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
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
export async function lockShopForOrders(
  id: string,
): Promise<{ status: ShopStatus; openingStocktakeId: string | null; orderCutoffAt: Date | null } | undefined> {
  const [row] = await getDb()
    .select({ status: shops.status, openingStocktakeId: shops.openingStocktakeId, orderCutoffAt: shops.orderCutoffAt })
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

/**
 * Lưu token vừa làm mới (#201) khi gian hàng còn gọi được sàn (`connecting`, `active`) **và** `access_token_enc` vẫn là bản
 * bên gọi đọc lúc bắt đầu làm mới (`expectedAccessEnc`, compare-and-set). Không khớp nghĩa là người dùng vừa nối lại gian
 * hàng (`attachAll` ghi cặp token mới ngoài khoá làm mới): bỏ cặp vừa lấy, giữ cặp của lần nối. Không xét và không tăng
 * `version`: việc nền đổi token không phải thay đổi người dùng phải tải lại. Bên gọi giữ khoá `channel.token:<id>` nên không
 * có hai lần làm mới đè nhau. Trả `false` khi gian hàng đã ngắt, mất uỷ quyền hay vừa được nối lại trong lúc gọi sàn.
 */
export async function saveRefreshedTokens(
  id: string,
  expectedAccessEnc: Buffer | null,
  tokens: Pick<typeof shops.$inferInsert, 'accessTokenEnc' | 'refreshTokenEnc' | 'accessExpiresAt' | 'refreshExpiresAt' | 'authExpiresAt'>,
): Promise<boolean> {
  const sameToken = expectedAccessEnc ? eq(shops.accessTokenEnc, expectedAccessEnc) : isNull(shops.accessTokenEnc);
  const rows = await getDb()
    .update(shops)
    .set({ ...tokens, updatedAt: sql`now()` })
    .where(and(eq(shops.id, id), inArray(shops.status, ['connecting', 'active']), sameToken))
    .returning({ id: shops.id });
  return rows.length > 0;
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
 * Listing đang `pushing` của gian hàng vừa ngắt: việc đẩy đã bị bỏ (`dropHeld`) hoặc sẽ tự `fail` khi chạy, nên chuyển
 * `push_failed` ngay kèm `shop_not_connected` để bảng không hiện "Đang đẩy" mãi (#219). Gọi trong giao dịch ngắt.
 */
export async function failPushingForDisconnect(shopId: string): Promise<{ id: string }[]> {
  const error = { code: 'shop_not_connected', message: 'Gian hàng đã ngắt', at: new Date().toISOString() };
  return getDb()
    .update(listings)
    .set({ status: 'push_failed', pushError: error, version: sql`${listings.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(listings.shopId, shopId), eq(listings.status, 'pushing')))
    .returning({ id: listings.id });
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

/** Khoá thiết lập của công ty tới hết giao dịch: hai lần thiết lập gian hàng cùng công ty chạy lần lượt (#198 A12). */
export async function lockCompanySetup(companyId: string): Promise<void> {
  await getDb().execute(sql`select pg_advisory_xact_lock(hashtext('channel.setup'), hashtext(${companyId}))`);
}

/**
 * Nhận `fulfillment.allocation_done` có `cause.documentId` (Documents/21 §11.2, §18.6.11): gian hàng đang chờ phân hàng
 * theo đúng phiếu này thì thoát chờ (`allocation_stocktake_id = null`). Sự kiện do `settleOpeningStocktake` phát trong
 * giao dịch thoát chờ kiểm kê nên chỉ tới sau khi giao dịch đó commit; nhận trùng thì cột đã null, không trúng dòng nào
 * (Documents/19 `shops`). Trả các gian hàng vừa thoát chờ. Không tăng `version` (việc nền, như `markStockPushed`). Gọi
 * trong `withCompany`.
 */
export async function settleStocktakeAllocation(
  documentId: string,
): Promise<{ id: string; status: ShopStatus; openOrdersPulledAt: Date | null }[]> {
  return getDb()
    .update(shops)
    .set({ allocationStocktakeId: null, updatedAt: sql`now()` })
    .where(eq(shops.allocationStocktakeId, documentId))
    .returning({ id: shops.id, status: shops.status, openOrdersPulledAt: shops.openOrdersPulledAt });
}

/** Đánh dấu lượt đẩy tồn đầu tiên sau thiết lập đã chạy (§18.7.7 `push_stock`). Không tăng `version`. */
export async function markStockPushed(id: string): Promise<void> {
  await getDb()
    .update(shops)
    .set({ stockPushedAt: sql`now()` })
    .where(and(eq(shops.id, id), sql`${shops.stockPushedAt} is null`));
}

/** Lỗi lượt kéo đơn còn mở ghi vào `last_error` bắt đầu bằng câu này; lượt xong thì xoá đúng lỗi đó (#198 P3). */
/**
 * Lượt lấy đơn bắt đầu lúc `startedAt` đã chạy xong trọn (#223): đặt `orders_pulled_ok_at`, không lùi. Chỉ khi gian hàng
 * còn `active` và còn đúng `version` đọc lúc bắt đầu lượt: mất uỷ quyền hay nối lại giữa lượt (đều tăng `version`) thì lượt
 * này không chứng minh được đơn lúc đứt đã về, bỏ mốc. Không tăng `version` (việc nền, như `markStockPushed`).
 */
export async function markOrdersPulled(id: string, version: number, startedAt: Date): Promise<boolean> {
  const rows = await getDb()
    .update(shops)
    .set({ ordersPulledOkAt: sql`greatest(coalesce(${shops.ordersPulledOkAt}, ${startedAt}), ${startedAt})` })
    .where(and(eq(shops.id, id), eq(shops.version, version), eq(shops.status, 'active')))
    .returning({ id: shops.id });
  return rows.length > 0;
}

export const OPEN_ORDER_PULL_ERROR = 'Lượt kéo đơn còn mở chưa xong';

/** Lượt kéo đơn còn mở xong (#198 A10): từ giờ `syncListings` mới đẩy tồn. `skipped`: số đơn bỏ vì trần. Không tăng `version`. */
export async function markOpenOrdersPulled(id: string, skipped: number): Promise<void> {
  await getDb()
    .update(shops)
    .set({
      openOrdersPulledAt: sql`coalesce(${shops.openOrdersPulledAt}, now())`,
      openOrdersSkipped: skipped,
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

/**
 * Gian hàng trong `ids` đang chờ kiểm kê đầu kỳ (có phiếu đầu kỳ chưa ghi sổ), cho fulfillment (spec 199b §5.6).
 * `lock`: khoá `FOR SHARE` tới hết giao dịch, cùng loại với `lockShopForOrders`, để gian hàng không thoát chờ giữa chừng.
 */
export async function awaitingStocktakeShops(ids: readonly string[], opts: { lock?: boolean } = {}): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const query = getDb()
    .select({ id: shops.id })
    .from(shops)
    .where(and(inArray(shops.id, [...new Set(ids)]), sql`${shops.openingStocktakeId} is not null`))
    .orderBy(asc(shops.id));
  const rows = opts.lock ? await query.for('share') : await query;
  return new Set(rows.map((r) => r.id));
}
