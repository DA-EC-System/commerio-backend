// API công khai của module `channel`: gian hàng sàn, token, ghép SKU, dữ liệu gốc sàn. Không đổi tồn.
// Module khác chỉ được import từ file này.
import { registerConsumer, workQueue } from '../../core/index.ts';
import type { ModuleDefinition } from '../../../shared/module.ts';
import { registerChannelOpenApi } from './api/openapi.ts';
import { channelRouter } from './api/routes.ts';
import { runListingSync, runOpenOrderPull, runOrderPull, runTokenRefresh } from './service/background.ts';
import { markStockPending } from './service/listing-sync.ts';
import { productPort } from './service/product-port.ts';
import { listingSyncQueue, openOrderPullQueue, orderPullQueue, reconcileShopJobs, tokenRefreshQueue } from './service/shop-jobs.ts';

export const channelModule: ModuleDefinition = {
  name: 'channel',
  router: channelRouter,
  openapi: registerChannelOpenApi,
  async startBackground(ctx) {
    // Tồn đổi thì listing chờ đẩy tồn (chỉ ghi DB, đúng một lần); lượt đồng bộ sau mới gọi sàn, không gọi sàn trong giao dịch.
    registerConsumer('inventory.stock_changed', (e) => markStockPending(e.payload.variantId), { consumer: 'channel-stock-push' });
    // Việc nền của gian hàng (#102): kéo đơn 5 phút, đồng bộ listing 15 phút, làm mới token hằng ngày.
    const port = productPort(ctx);
    await workQueue(listingSyncQueue, (job) => runListingSync(port, job));
    await workQueue(orderPullQueue, runOrderPull);
    await workQueue(openOrderPullQueue, runOpenOrderPull);
    await workQueue(tokenRefreshQueue, runTokenRefresh);
    await reconcileShopJobs();
    // pg-boss dừng chung ở platform (dừng nhận việc, chờ việc đang chạy).
    return async () => {};
  },
};

export { getShops, type ShopRef } from './service/shops-lookup.ts';
// Cho #133 (sàn báo gỡ app): `loseShopAuth` gọi ngoài giao dịch, đặt `needs_reauth` và dừng lịch việc nền của gian hàng.
export { loseShopAuth, markNeedsReauth } from './service/shops.ts';
// Cho finance kéo quyết toán (#117), tiêm qua `ctx.settlementSource` ở `src/wiring.ts`.
export { settlementPayouts, settlementTransactions, shopsToSettle } from './service/settlement-port.ts';
export type { Payout, SettlementTxn } from './service/marketplaces/index.ts';

/** Chặn tắt phân hệ Kênh bán khi đã có gian hàng (#152); `src/wiring.ts` đưa cho `platform`. */
export { hasChannelData } from './repository/shops.ts';
// Thao tác đơn trên sàn cho `order` (#105 PR 2), tiêm qua `ctx.marketplaceOrders` ở `src/wiring.ts`.
export { marketplaceCancelOrder, marketplaceCancelReasons, marketplaceDecideCancel } from './service/order-actions.ts';
