// Kéo đơn sàn theo gian hàng (#105 A7): từ mốc `last_order_sync_at` (lần đầu: `order_cutoff_at`) lùi 2 phút, cũ trước,
// mỗi đơn đổi `updated_at` thì gọi chi tiết rồi giao `order` trong một giao dịch. Gọi sàn ngoài giao dịch. Lỗi giữa
// chừng thì dừng, mốc ở đơn cuối đã xong; lần sau làm tiếp. Thử lại, khoá giữa nhiều worker là của #102.
import { ingestMarketplaceOrder } from '../../../order/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { advanceOrderCursor, findRawOrderTimes, saveRawOrder, variantsBySellerSku } from '../repository/raw-orders.ts';
import { findActiveShopsAnyCompany } from '../repository/shops.ts';
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
    for (let offset = 0; ; ) {
      const page = await onMarketplace(() => adapter.listOrders!(accessToken, since, offset));
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
        done = ref.updatedAt;
      }
      offset += page.orders.length;
      if (!page.hasMore || !page.orders.length) break;
    }
  } finally {
    const at = done;
    if (at) await withCompany(companyId, () => advanceOrderCursor(shopId, at));
  }
  return result;
}

/** Một vòng kéo đơn của mọi gian hàng đang hoạt động; gian hàng lỗi không chặn gian hàng khác. */
export async function pullAllShopsOrdersOnce(): Promise<void> {
  for (const shop of await findActiveShopsAnyCompany()) {
    try {
      await pullShopOrders(shop.companyId, shop.id);
    } catch (err) {
      logger.warn({ err, shopId: shop.id }, 'kéo đơn sàn lỗi');
    }
  }
}
