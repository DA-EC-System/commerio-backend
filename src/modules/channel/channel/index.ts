// API công khai của module `channel`: gian hàng sàn, token, ghép SKU, dữ liệu gốc sàn. Không đổi tồn.
// Module khác chỉ được import từ file này.
import { registerConsumer, workQueue } from '../../core/index.ts';
import type { ModuleDefinition } from '../../../shared/module.ts';
import { registerChannelOpenApi } from './api/openapi.ts';
import { channelRouter } from './api/routes.ts';
import { runListingSync, runOpenOrderPull, runOrderPull, runStockPush, runTokenRefresh } from './service/background.ts';
import { runListingPush } from './service/listing-push.ts';
import { onAvailableChanged } from './service/listing-sync.ts';
import { handleAllocationDone, handleStocktakePosted } from './service/opening-stocktake.ts';
import { productPort } from './service/product-port.ts';
import { handleReauthMail, REAUTH_MAIL_CONSUMER, startReauthMailLoop } from './service/reauth-mail.ts';
import {
  listingPushQueue,
  listingSyncQueue,
  openOrderPullQueue,
  orderPullQueue,
  reconcileShopJobs,
  stockPushQueue,
  tokenRefreshQueue,
} from './service/shop-jobs.ts';

export const channelModule: ModuleDefinition = {
  name: 'channel',
  router: channelRouter,
  openapi: registerChannelOpenApi,
  async startBackground(ctx) {
    // Phiếu kiểm kê đầu kỳ ghi sổ: gian hàng thoát chờ kiểm kê, mốc kéo đơn = thời điểm đếm, bật đẩy tồn (#198 phần 2).
    registerConsumer('inventory.stocktake_posted', handleStocktakePosted, { consumer: 'channel-opening-stocktake' });
    // Fulfillment phân hàng xong: gian hàng vừa thoát chờ kiểm kê hết chờ phân hàng thì mới đẩy tồn lần đầu (#198, 25 §6.1 bước 3).
    registerConsumer('fulfillment.allocation_done', handleAllocationDone, { consumer: 'channel-allocation-done' });
    // Chia hàng xong (số có thể bán đổi) mới đẩy tồn (#223, 21 §11.2): đánh dấu chờ đẩy và xếp `channel.stock_push`, không
    // gọi sàn trong giao dịch của consumer. Thay consumer `inventory.stock_changed` cũ.
    registerConsumer('fulfillment.allocation_done', (e) => onAvailableChanged(e.payload), { consumer: 'channel-stock-push' });
    // Việc nền của gian hàng (#102): kéo đơn 5 phút, đồng bộ listing 15 phút, làm mới token hằng ngày.
    const port = productPort(ctx);
    await workQueue(listingSyncQueue, (job) => runListingSync(port, job));
    await workQueue(orderPullQueue, runOrderPull);
    await workQueue(openOrderPullQueue, runOpenOrderPull);
    await workQueue(tokenRefreshQueue, runTokenRefresh);
    await workQueue(stockPushQueue, (job) => runStockPush(port, job));
    // Đẩy listing (#219): mỗi lần một việc; nâng `concurrency` khi đo được hạn mức gọi sàn (#215).
    await workQueue(listingPushQueue, (job) => runListingPush(port, job));
    await reconcileShopJobs();
    // Thư báo CEO, Admin khi gian hàng sắp hết hoặc đã mất uỷ quyền (#312): xếp mốc mỗi 15 phút, consumer gửi thư.
    registerConsumer('channel.shop_reauth_mail', handleReauthMail, { consumer: REAUTH_MAIL_CONSUMER });
    const stopReauthMail = startReauthMailLoop();
    // pg-boss dừng chung ở platform (dừng nhận việc, chờ việc đang chạy).
    return stopReauthMail;
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
// Trạng thái chờ kiểm kê đầu kỳ của gian hàng cho fulfillment (#199 phần b), tiêm qua `ctx.stockHoldOf` ở `src/wiring.ts`.
export { awaitingStocktakeShops } from './repository/shops.ts';
// Thao tác đơn trên sàn cho `order` (#105 PR 2), tiêm qua `ctx.marketplaceOrders` ở `src/wiring.ts`.
export { marketplaceCancelOrder, marketplaceCancelReasons, marketplaceDecideCancel } from './service/order-actions.ts';
// Thao tác yêu cầu trả trên sàn cho `order` (#202), tiêm qua `ctx.marketplaceReturns`.
export { marketplaceReturns } from './service/return-actions.ts';
// Tách kiện, giao kiện trên sàn cho fulfillment (#221; #205, #239 gọi), tiêm qua `ctx.marketplacePackages` ở `src/wiring.ts`.
export {
  marketplaceCarriers, marketplacePack, marketplaceReadyToShip, marketplaceRepack, marketplaceShipPackage,
  marketplaceShippingDocuments, marketplaceSplitAttributes, marketplaceSplitLevel, marketplaceSplitOrder,
} from './service/order-actions.ts';
