// Kéo đơn sàn theo gian hàng (#105 A7): từ mốc `last_order_sync_at` (lần đầu: `order_cutoff_at`) lùi 2 phút, cũ trước,
// lật trang bằng con trỏ của adapter (#218); mỗi đơn đổi `updated_at` thì gọi chi tiết rồi giao `order` trong một giao
// dịch. Gọi sàn ngoài giao dịch. Mốc tới đơn cuối đã xong nhưng không qua `safeUntil` adapter báo; lỗi giữa chừng thì
// dừng, lần sau làm tiếp. Lịch, thử lại, một việc mỗi gian hàng: hàng `channel.order_pull` (#102, `shop-jobs.ts`).
import { sendJob } from '../../../core/index.ts';
import { ingestMarketplaceOrder } from '../../../order/index.ts';
import { env } from '../../../../shared/config/env.ts';
import { logger } from '../../../../shared/logger.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { advanceOrderCursor, findRawOrderTimes, saveRawOrder, variantsBySellerSku } from '../repository/raw-orders.ts';
import {
  MarketplaceError,
  type MarketplaceAdapter,
  type RemoteLineStatus,
  type RemoteOrder,
  type RemoteOrderRef,
} from './marketplaces/common.ts';
import { lockShopForOrders, markOpenOrdersPulled } from '../repository/shops.ts';
import { listingSyncQueue } from './shop-jobs.ts';
import { onMarketplace, shopSession } from './shops.ts';

const OVERLAP_MS = 2 * 60_000;
// Chặn số trang mỗi lượt, phòng adapter lỗi trả con trỏ không bao giờ hết; lượt sau làm tiếp từ mốc.
const MAX_PAGES = 500;

export interface PullResult {
  pulled: number;
  created: number;
  updated: number;
}

interface Session {
  companyId: string;
  shopId: string;
  adapter: MarketplaceAdapter;
  accessToken: string;
}

/** Sàn có `getOrders` thì lấy chi tiết cả lô một lần, ngoài giao dịch (#267); không có thì null, gọi từng đơn sau. */
async function prefetch({ adapter, accessToken }: Session, refs: readonly RemoteOrderRef[]): Promise<Map<string, RemoteOrder> | null> {
  if (!adapter.getOrders) return null;
  if (!refs.length) return new Map();
  const remotes = await onMarketplace(() => adapter.getOrders!(accessToken, refs));
  return new Map(remotes.map((r, i) => [refs[i]!.externalOrderId, r]));
}

/** Chi tiết một đơn: bản đã lấy theo lô, hoặc `getOrder` (lỗi giữa chừng thì các đơn trước đã lưu). */
async function remoteOf({ adapter, accessToken }: Session, ref: RemoteOrderRef, batch: Map<string, RemoteOrder> | null) {
  return batch?.get(ref.externalOrderId) ?? onMarketplace(() => adapter.getOrder!(accessToken, ref.externalOrderId));
}

// Món đã rời kho: chỉ đơn có món như vậy (hoặc món huỷ vì giao không thành) mới cần hành trình kiện (spec #199 phần c §5.7).
const AFTER_HANDOVER: readonly RemoteLineStatus[] = ['in_transit', 'delivered', 'delivery_failed', 'returning', 'returned', 'return_failed', 'lost'];

/**
 * Gắn hành trình kiện vào đơn (spec #199 phần c §5.7, D3), gọi ngoài giao dịch, qua giới hạn tốc độ của sàn. Mốc giờ là
 * thông tin phụ: lỗi bất kỳ chỉ log `warn`, đơn đi tiếp không có hành trình (kiện lấy giờ đồng bộ, lý do mặc định).
 */
async function withPackageEvents({ adapter, accessToken, shopId }: Session, remote: RemoteOrder): Promise<RemoteOrder> {
  if (!adapter.getPackageEvents) return remote;
  const wanted = remote.lines.some(
    (l) => (l.status !== null && AFTER_HANDOVER.includes(l.status)) || (l.status === 'cancelled' && l.info.cancelKind === 'failed_delivery'),
  );
  if (!wanted) return remote;
  try {
    const packageEvents = await onMarketplace(() => adapter.getPackageEvents!(accessToken, remote.externalOrderId));
    return { ...remote, packageEvents };
  } catch (err) {
    logger.warn({ err, shopId, externalOrderId: remote.externalOrderId }, 'đọc hành trình kiện lỗi');
    return remote;
  }
}

/** Giao `order` một đơn đã lấy chi tiết và lưu bản gốc trong một giao dịch; hành trình kiện đọc trước, ngoài giao dịch. */
async function ingestRemote(session: Session, fetched: RemoteOrder, result: PullResult) {
  const { companyId, shopId } = session;
  const remote = await withPackageEvents(session, fetched);
  const res = await withCompany(companyId, async () => {
    // Khoá chia sẻ dòng gian hàng tới hết giao dịch: không chèn đơn vào gian hàng vừa ngắt (#207).
    const locked = await lockShopForOrders(shopId);
    if (!locked || locked.status === 'disconnected') {
      throw new AppError(409, 'shop_not_connected', 'Gian hàng đã ngắt', { current: 'disconnected' });
    }
    const variants = await variantsBySellerSku(shopId, remote.lines.map((l) => l.sellerSku));
    const r = await ingestMarketplaceOrder({
      ...remote,
      shopId,
      // Chờ kiểm kê đầu kỳ thì không giữ hàng (25 §6.1 bước 3); đọc dưới khoá chia sẻ nên không lệch lúc ghi sổ phiếu.
      holdStock: locked.openingStocktakeId === null,
      // Kiện lần đầu thấy đã rời kho của đơn đặt trước mốc thì không trừ tồn (#199, 25 §8.1).
      orderCutoffAt: locked.orderCutoffAt,
      lines: remote.lines.map((l) => ({ ...l, variantId: variants.get(l.sellerSku) ?? null })),
    });
    await saveRawOrder({
      shopId,
      orderId: r.orderId,
      externalOrderId: remote.externalOrderId,
      externalStatus: remote.rawStatus,
      payload: remote,
      externalUpdateTime: remote.updatedAt,
    });
    return r;
  });
  result.pulled += 1;
  if (res.created) result.created += 1;
  else if (res.changed) result.updated += 1;
}

export async function pullShopOrders(companyId: string, shopId: string): Promise<PullResult> {
  const { shop, adapter, accessToken } = await withCompany(companyId, () => shopSession(shopId));
  if (!adapter.listOrders || !(adapter.getOrder || adapter.getOrders)) throw new AppError(422, 'marketplace_unsupported', 'Sàn này chưa hỗ trợ kéo đơn');
  const session = { companyId, shopId, adapter, accessToken };
  const result: PullResult = { pulled: 0, created: 0, updated: 0 };
  const cutoff = shop.orderCutoffAt;
  if (!cutoff) return result;
  const since = new Date((shop.lastOrderSyncAt ?? cutoff).getTime() - OVERLAP_MS);

  // `done`: `updatedAt` lớn nhất đã xử lý (adapter trả không giảm theo `updatedAt`); `safe`: `safeUntil` nhỏ nhất của lượt.
  let done: Date | null = null;
  let safe: Date | null = null;
  try {
    let cursor: string | null = null;
    for (let pages = 0; pages < MAX_PAGES; pages++) {
      const prev = cursor;
      const page = await onMarketplace(async () => {
        const p = await adapter.listOrders!(accessToken, since, prev);
        if (p.nextCursor !== null && p.nextCursor === prev) throw new MarketplaceError('rejected', 'cursor_stuck', 'Adapter trả lại con trỏ cũ');
        return p;
      });
      if (page.safeUntil && (!safe || page.safeUntil < safe)) safe = page.safeUntil;
      const known = await withCompany(companyId, () => findRawOrderTimes(shopId, page.orders.map((o) => o.externalOrderId)));
      // Đơn đặt trước mốc chỉ nhận khi đã có trong DB (về qua lượt kéo đơn còn mở, #198; Documents/21 §18.2).
      const wanted = page.orders.filter((ref) => {
        const seen = known.get(ref.externalOrderId);
        return (ref.placedAt >= cutoff || seen) && !(seen && seen >= ref.updatedAt);
      });
      const batch = await prefetch(session, wanted);
      for (const ref of page.orders) {
        if (wanted.includes(ref)) await ingestRemote(session, await remoteOf(session, ref, batch), result);
        if (!done || ref.updatedAt > done) done = ref.updatedAt;
      }
      cursor = page.nextCursor;
      if (!cursor) break;
    }
  } finally {
    const at = done && safe && safe < done ? safe : done;
    if (at) await withCompany(companyId, () => advanceOrderCursor(shopId, at));
  }
  return result;
}

/**
 * Lượt kéo đơn **còn mở** một lần sau thiết lập (#198; Documents/21 §18.2): mọi đơn chưa xong bất kể ngày đặt, để kiện
 * chưa rời kho giữ hàng trước lần đẩy tồn đầu (A10). Không tiến `last_order_sync_at`. Xong trọn thì đặt
 * `open_orders_pulled_at` và xếp việc đồng bộ listing (lúc đó mới đẩy tồn); adapter báo `safeUntil` hay hết số trang thì
 * ném để pg-boss chạy lại cả lượt (đơn đã có bỏ qua nhờ `raw_orders`). Sàn chưa có `listOpenOrders` thì đặt cột ngay.
 *
 * Không đặt `OPEN_ORDER_PULL_MAX` thì nhận theo từng trang. Có đặt thì đơn đặt từ mốc vẫn nhận theo trang (vòng 5 phút
 * vốn nhận), còn đơn đặt trước mốc chỉ lấy N đơn **đặt mới nhất**: sàn trả theo trạng thái rồi `updated_at`, không theo
 * ngày đặt, nên phải lật hết danh sách (mỗi trang một lần gọi) rồi mới chọn; chỉ đơn được chọn mới gọi chi tiết. Chạy
 * lại thì chọn lại đúng tập đó khi danh sách trên sàn chưa đổi.
 */
const incomplete = (message: string) => new AppError(503, 'open_orders_incomplete', message);
// Số đơn mỗi lần lấy chi tiết ở lượt đơn mở (bội của lô 50 của Lazada `/orders/items/get`, #267).
const FETCH_BATCH = 100;

/** N đơn đặt mới nhất (trùng giờ thì mã đơn lớn hơn trước, để chạy lại chọn y như cũ); `max` không đặt thì giữ hết. */
function newestOpenOrders(refs: RemoteOrderRef[], max: number | undefined): RemoteOrderRef[] {
  if (max === undefined || refs.length <= max) return refs;
  return refs
    .sort((a, b) => b.placedAt.getTime() - a.placedAt.getTime() || b.externalOrderId.localeCompare(a.externalOrderId))
    .slice(0, max);
}

export async function pullOpenOrders(companyId: string, shopId: string): Promise<PullResult & { skipped: number }> {
  const { shop, adapter, accessToken } = await withCompany(companyId, () => shopSession(shopId));
  const result = { pulled: 0, created: 0, updated: 0, skipped: 0 };
  if (!shop.orderCutoffAt || shop.openOrdersPulledAt) return result;
  const cutoff = shop.orderCutoffAt;
  if (adapter.listOpenOrders && (adapter.getOrder || adapter.getOrders)) {
    const max = env.OPEN_ORDER_PULL_MAX;
    const session = { companyId, shopId, adapter, accessToken };
    const ingestNew = async (refs: readonly RemoteOrderRef[]) => {
      // Lô `FETCH_BATCH` đơn: lỗi giữa chừng thì các lô trước đã lưu, chạy lại bỏ qua nhờ `raw_orders`.
      for (let i = 0; i < refs.length; i += FETCH_BATCH) {
        const batch = refs.slice(i, i + FETCH_BATCH);
        const known = await withCompany(companyId, () => findRawOrderTimes(shopId, batch.map((o) => o.externalOrderId)));
        const wanted = batch.filter((ref) => {
          const seen = known.get(ref.externalOrderId);
          return !(seen && seen >= ref.updatedAt);
        });
        const fetched = await prefetch(session, wanted);
        for (const ref of wanted) await ingestRemote(session, await remoteOf(session, ref, fetched), result);
      }
    };
    // Đơn trước mốc chờ chọn khi có trần; đơn trả hai lần giữ bản `updatedAt` mới hơn.
    const held = new Map<string, RemoteOrderRef>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      if (++pages > MAX_PAGES) throw incomplete(`Lượt kéo đơn còn mở quá ${MAX_PAGES} trang`);
      const prev: string | null = cursor;
      const page = await onMarketplace(async () => {
        const p = await adapter.listOpenOrders!(accessToken, prev);
        if (p.nextCursor !== null && p.nextCursor === prev) throw new MarketplaceError('rejected', 'cursor_stuck', 'Adapter trả lại con trỏ cũ');
        return p;
      });
      // Sàn chưa chốt dữ liệu tới hiện tại: có thể sót đơn, chạy lại cả lượt thay vì đặt cột (#198 P3).
      if (page.safeUntil) throw incomplete(`Sàn chỉ chắc dữ liệu đơn tới ${page.safeUntil.toISOString()}, chạy lại lượt`);
      const now: RemoteOrderRef[] = [];
      for (const ref of page.orders) {
        if (max === undefined || ref.placedAt >= cutoff) {
          now.push(ref);
          continue;
        }
        const had = held.get(ref.externalOrderId);
        if (!had || ref.updatedAt > had.updatedAt) held.set(ref.externalOrderId, ref);
      }
      await ingestNew(now);
      cursor = page.nextCursor;
    } while (cursor);

    const chosen = newestOpenOrders([...held.values()], max);
    result.skipped = held.size - chosen.length;
    await ingestNew(chosen);
  }
  await withCompany(companyId, async () => {
    await markOpenOrdersPulled(shopId, result.skipped);
    await sendJob(listingSyncQueue, { companyId, shopId }, { key: shopId });
  });
  return result;
}
