// Kéo đơn sàn theo gian hàng (#105 A7): từ mốc `last_order_sync_at` (lần đầu: `order_cutoff_at`) lùi 2 phút, cũ trước,
// lật trang bằng con trỏ của adapter (#218); mỗi đơn đổi `updated_at` thì gọi chi tiết rồi giao `order` trong một giao
// dịch. Gọi sàn ngoài giao dịch. Mốc tới đơn cuối đã xong nhưng không qua `safeUntil` adapter báo; lỗi giữa chừng thì
// dừng, lần sau làm tiếp. Lịch, thử lại, một việc mỗi gian hàng: hàng `channel.order_pull` (#102, `shop-jobs.ts`).
import { sendJob } from '../../../core/index.ts';
import { ingestMarketplaceOrder } from '../../../order/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { advanceOrderCursor, findRawOrderTimes, saveRawOrder, variantsBySellerSku } from '../repository/raw-orders.ts';
import { MarketplaceError, type MarketplaceAdapter } from './marketplaces/common.ts';
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

/** Gọi chi tiết một đơn (ngoài giao dịch) rồi giao `order` và lưu bản gốc trong một giao dịch. */
async function ingestRemote({ companyId, shopId, adapter, accessToken }: Session, externalOrderId: string, result: PullResult) {
  const remote = await onMarketplace(() => adapter.getOrder!(accessToken, externalOrderId));
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
  if (!adapter.listOrders || !adapter.getOrder) throw new AppError(422, 'marketplace_unsupported', 'Sàn này chưa hỗ trợ kéo đơn');
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
      for (const ref of page.orders) {
        const seen = known.get(ref.externalOrderId);
        // Đơn đặt trước mốc chỉ nhận khi đã có trong DB (về qua lượt kéo đơn còn mở, #198; Documents/21 §18.2).
        if ((ref.placedAt >= cutoff || seen) && !(seen && seen >= ref.updatedAt)) {
          await ingestRemote(session, ref.externalOrderId, result);
        }
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
 */
export async function pullOpenOrders(companyId: string, shopId: string): Promise<PullResult> {
  const { shop, adapter, accessToken } = await withCompany(companyId, () => shopSession(shopId));
  const result: PullResult = { pulled: 0, created: 0, updated: 0 };
  if (!shop.orderCutoffAt || shop.openOrdersPulledAt) return result;
  if (adapter.listOpenOrders && adapter.getOrder) {
    const session = { companyId, shopId, adapter, accessToken };
    let cursor: string | null = null;
    let pages = 0;
    do {
      if (++pages > MAX_PAGES) throw new Error(`Lượt kéo đơn còn mở quá ${MAX_PAGES} trang`);
      const prev: string | null = cursor;
      const page = await onMarketplace(async () => {
        const p = await adapter.listOpenOrders!(accessToken, prev);
        if (p.nextCursor !== null && p.nextCursor === prev) throw new MarketplaceError('rejected', 'cursor_stuck', 'Adapter trả lại con trỏ cũ');
        return p;
      });
      // Sàn chưa chốt dữ liệu tới hiện tại: có thể sót đơn, chạy lại cả lượt thay vì đặt cột (#198 P3).
      if (page.safeUntil) throw new Error(`Sàn chỉ chắc dữ liệu đơn tới ${page.safeUntil.toISOString()}, chạy lại lượt`);
      const known = await withCompany(companyId, () => findRawOrderTimes(shopId, page.orders.map((o) => o.externalOrderId)));
      for (const ref of page.orders) {
        const seen = known.get(ref.externalOrderId);
        if (!(seen && seen >= ref.updatedAt)) await ingestRemote(session, ref.externalOrderId, result);
      }
      cursor = page.nextCursor;
    } while (cursor);
  }
  await withCompany(companyId, async () => {
    await markOpenOrdersPulled(shopId);
    await sendJob(listingSyncQueue, { companyId, shopId }, { key: shopId });
  });
  return result;
}
