// Kéo đơn sàn theo gian hàng (#105 A7): từ mốc `last_order_sync_at` (lần đầu: `order_cutoff_at`) lùi 2 phút, cũ trước,
// lật trang bằng con trỏ của adapter (#218); mỗi đơn đổi `updated_at` thì gọi chi tiết rồi giao `order` trong một giao
// dịch. Gọi sàn ngoài giao dịch. Lỗi giữa chừng thì dừng, mốc ở đơn cuối đã xong; lần sau làm tiếp. Lịch, thử lại, một
// việc mỗi gian hàng: hàng `channel.order_pull` (#102, `shop-jobs.ts`).
import { ingestMarketplaceOrder } from '../../../order/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { advanceOrderCursor, findRawOrderTimes, saveRawOrder, variantsBySellerSku } from '../repository/raw-orders.ts';
import { onMarketplace, shopSession } from './shops.ts';

const OVERLAP_MS = 2 * 60_000;

export interface PullResult {
  pulled: number;
  created: number;
  updated: number;
}

export async function pullShopOrders(companyId: string, shopId: string): Promise<PullResult> {
  const { shop, adapter, accessToken } = await withCompany(companyId, () => shopSession(shopId));
  if (!adapter.listOrders || !adapter.getOrder) throw new AppError(422, 'marketplace_unsupported', 'Sàn này chưa hỗ trợ kéo đơn');
  const result: PullResult = { pulled: 0, created: 0, updated: 0 };
  const cutoff = shop.orderCutoffAt;
  if (!cutoff) return result;
  const since = new Date((shop.lastOrderSyncAt ?? cutoff).getTime() - OVERLAP_MS);

  let done: Date | null = null;
  try {
    let cursor: string | null = null;
    do {
      const page = await onMarketplace(() => adapter.listOrders!(accessToken, since, cursor));
      const known = await withCompany(companyId, () => findRawOrderTimes(shopId, page.orders.map((o) => o.externalOrderId)));
      for (const ref of page.orders) {
        const seen = known.get(ref.externalOrderId);
        if (ref.placedAt >= cutoff && !(seen && seen >= ref.updatedAt)) {
          const remote = await onMarketplace(() => adapter.getOrder!(accessToken, ref.externalOrderId));
          const res = await withCompany(companyId, async () => {
            const variants = await variantsBySellerSku(shopId, remote.lines.map((l) => l.sellerSku));
            const r = await ingestMarketplaceOrder({
              ...remote,
              shopId,
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
        if (!done || ref.updatedAt > done) done = ref.updatedAt;
      }
      cursor = page.nextCursor;
    } while (cursor);
  } finally {
    const at = done;
    if (at) await withCompany(companyId, () => advanceOrderCursor(shopId, at));
  }
  return result;
}
