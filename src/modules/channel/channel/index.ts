// API công khai của module `channel`: gian hàng sàn, token, ghép SKU, dữ liệu gốc sàn. Không đổi tồn.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../../shared/module.ts';
import { registerChannelOpenApi } from './api/openapi.ts';
import { channelRouter } from './api/routes.ts';
import { runListingSync, runOpenOrderPull, runOrderPull, runStockPush, runTokenRefresh } from './service/background.ts';
import { registerChannelConsumer, workChannelQueue } from './service/background-jobs.ts';
import { runCategoryApply } from './service/category-apply.ts';
import { runListingPush } from './service/listing-push.ts';
import { runProductPush } from './service/product-push.ts';
import { runProductRegroup } from './service/product-regroup.ts';
import { runRemoteSkusRefresh } from './service/remote-skus.ts';
import { runSpecFromMatch } from './service/spec-from-match.ts';
import { onAvailableChanged } from './service/listing-sync.ts';
import { onSpecFieldDeleted, onSpecOptionDeleted } from './service/spec-mappings.ts';
import { handleAllocationDone, handleStocktakePosted } from './service/opening-stocktake.ts';
import { onConfigActivated, onStockChanged, onVariantPriceChanged } from './service/repricing.ts';
import { productPort } from './service/product-port.ts';
import { handleReauthMail, REAUTH_MAIL_CONSUMER, startReauthMailLoop } from './service/reauth-mail.ts';
import {
  categoryApplyQueue,
  listingPushQueue,
  productPushQueue,
  productRegroupQueue,
  listingSyncQueue,
  openOrderPullQueue,
  orderPullQueue,
  reconcileShopJobs,
  remoteSkusRefreshQueue,
  specFromMatchQueue,
  stockPushQueue,
  tokenRefreshQueue,
} from './service/shop-jobs.ts';
import { onVariantStatusChanged } from './service/variant-status.ts';

import { categorySyncQueue, runCategorySync, scheduleCategorySync } from './service/category-sync.ts';

export const channelModule: ModuleDefinition = {
  name: 'channel',
  router: channelRouter,
  openapi: registerChannelOpenApi,
  async startBackground(ctx) {
    // Danh mục sàn trong DB phải khớp registry adapter (Documents/19 mục 3.3): lệch thì worker không chạy.
    await verifyMarketplaces();
    // Đăng ký qua `workChannelQueue`, `registerChannelConsumer` (`service/background-jobs.ts`): handler chạy như việc nền,
    // lời gọi sàn dùng tới hết phần hạn mức của công ty (#215, Documents/21 §18.6.8).
    // Phiếu kiểm kê đầu kỳ ghi sổ: gian hàng thoát chờ kiểm kê, mốc kéo đơn = thời điểm đếm, bật đẩy tồn (#198 phần 2).
    registerChannelConsumer('inventory.stocktake_posted', handleStocktakePosted, { consumer: 'channel-opening-stocktake' });
    // Fulfillment phân hàng xong: gian hàng vừa thoát chờ kiểm kê hết chờ phân hàng thì mới đẩy tồn lần đầu (#198, 25 §6.1 bước 3).
    registerChannelConsumer('fulfillment.allocation_done', handleAllocationDone, { consumer: 'channel-allocation-done' });
    // Chia hàng xong (số có thể bán đổi) mới đẩy tồn (#223, 21 §11.2): đánh dấu chờ đẩy và xếp `channel.stock_push`, không
    // gọi sàn trong giao dịch của consumer. Thay consumer `inventory.stock_changed` cũ.
    registerChannelConsumer('fulfillment.allocation_done', (e) => onAvailableChanged(e.payload), { consumer: 'channel-stock-push' });
    // Giá theo gian hàng (#225, 21 §11.2): đổi giá muốn bán, kích hoạt phí, thuế, lãi tối thiểu thì có bản chờ xác nhận.
    registerChannelConsumer('catalog.spec_field_deleted', onSpecFieldDeleted, { consumer: 'channel-spec-field-deleted' });
    registerChannelConsumer('catalog.spec_option_deleted', onSpecOptionDeleted, { consumer: 'channel-spec-option-deleted' });
    registerChannelConsumer('catalog.variant_price_changed', (e) => onVariantPriceChanged(e.payload), { consumer: 'channel-reprice-target' });
    registerChannelConsumer('finance.fee_config_activated', (e) => onConfigActivated(e.payload), { consumer: 'channel-reprice-config' });
    // Giá vốn đổi làm listing đang bán dưới giá thấp nhất: bản chờ đề xuất giá mới (#225 A1, 25 §6.2).
    registerChannelConsumer('inventory.stock_changed', (e) => onStockChanged(e.payload), { consumer: 'channel-reprice-cost' });
    // SKU vào, rời tạm ngừng: xếp `channel.stock_push` để ẩn, hiện listing trên sàn (#224, 21 §11.2, 25 §6.4).
    registerChannelConsumer('catalog.variant_status_changed', (e) => onVariantStatusChanged(e.payload), { consumer: 'channel-variant-status' });
    // Việc nền của gian hàng (#102): kéo đơn 5 phút, đồng bộ listing 15 phút, làm mới token hằng ngày.
    const port = productPort(ctx);
    await workChannelQueue(listingSyncQueue, (job) => runListingSync(port, job));
    await workChannelQueue(orderPullQueue, runOrderPull);
    await workChannelQueue(openOrderPullQueue, runOpenOrderPull);
    await workChannelQueue(tokenRefreshQueue, runTokenRefresh);
    await workChannelQueue(stockPushQueue, (job) => runStockPush(port, job));
    // Đẩy listing (#219): mỗi lần một việc; nâng `concurrency` khi đo được hạn mức gọi sàn (#215).
    await workChannelQueue(listingPushQueue, (job) => runListingPush(port, job));
    // Đẩy theo cha (#295): một sản phẩm sàn nhiều phân loại.
    await workChannelQueue(productPushQueue, (job) => runProductPush(port, job));
    // Gom lại dữ liệu cũ (#295): tạo một sản phẩm nhiều phân loại rồi xoá các sản phẩm lẻ.
    await workChannelQueue(productRegroupQueue, (job, attempt) => runProductRegroup(port, job, attempt));
    // Đổi category trên sàn (#467): mỗi (gian hàng, sản phẩm sàn) một việc, như đẩy listing.
    await workChannelQueue(categoryApplyQueue, (job, attempt) => runCategoryApply(port, job, attempt));
    // Tải lại SKU sàn chạy nền (#361): handler bọc `asManual`, lời gọi sàn vẫn tính như bấm tay.
    await workChannelQueue(remoteSkusRefreshQueue, (job, attempt) => runRemoteSkusRefresh(job, attempt, port));
    // Ghép SKU dựng spec từ category trên sàn (#400 lát 12).
    await workChannelQueue(specFromMatchQueue, (job) => runSpecFromMatch(port, job));
    // Cây category của sàn (#400): mỗi sàn một lượt đêm, lời gọi sàn chỉ tính trần chung.
    await workChannelQueue(categorySyncQueue, (job) => runCategorySync(job));
    await scheduleCategorySync();
    await reconcileShopJobs();
    // Thư báo CEO, Admin khi gian hàng sắp hết hoặc đã mất uỷ quyền (#312): xếp mốc mỗi 15 phút, consumer gửi thư.
    registerChannelConsumer('channel.shop_reauth_mail', handleReauthMail, { consumer: REAUTH_MAIL_CONSUMER });
    const stopReauthMail = startReauthMailLoop();
    // pg-boss dừng chung ở platform (dừng nhận việc, chờ việc đang chạy).
    return stopReauthMail;
  },
};

export { getShops, type ShopRef } from './service/shops-lookup.ts';
// #509: ánh xạ thông số mặc định cho công ty mới; core gọi qua `src/wiring.ts` sau seed của catalog (Documents/21 §11.3).
// Hạn trả của gian hàng cho sales tính hạn trả, tự hoàn tất (#236), tiêm qua `ctx.returnPoliciesOf` ở `src/wiring.ts`.
export { returnPoliciesOf, type ShopReturnPolicy } from './service/shops-lookup.ts';
// Cho #133 (sàn báo gỡ app): `loseShopAuth` gọi ngoài giao dịch, đặt `needs_reauth` và dừng lịch việc nền của gian hàng.
export { loseShopAuth, markNeedsReauth } from './service/shops.ts';
// Cho finance kéo quyết toán (#117), tiêm qua `ctx.settlementSource` ở `src/wiring.ts`.
export { settlementPayouts, settlementTransactions, shopsToSettle } from './service/settlement-port.ts';
export type { Payout, SettlementTxn } from './service/marketplaces/index.ts';

// Gian hàng của công ty cho checklist onboarding (#461).
export { shopSetupState } from './repository/shops.ts';
// Tồn trên sàn theo biến thể của phiếu kiểm kê đầu kỳ cho inventory (#569), tiêm qua `ctx.platformStockOf` ở `src/wiring.ts`.
export { remoteStockByVariant } from './repository/remote-skus.ts';
// Trạng thái chờ kiểm kê đầu kỳ của gian hàng cho fulfillment (#199 phần b), tiêm qua `ctx.stockHoldOf` ở `src/wiring.ts`.
export { awaitingStocktakeShops } from './repository/shops.ts';
// Lý do chặn lưu trữ SKU phần sàn cho catalog (#204), tiêm qua `ctx.listingArchiveBlockers` ở `src/wiring.ts`.
export { listingArchiveBlockers, listingInUse, listingPresenceOf, type VariantPresence } from './service/catalog-boundary.ts';
// Thao tác đơn trên sàn cho `order` (#105 PR 2), tiêm qua `ctx.marketplaceOrders` ở `src/wiring.ts`.
export { marketplaceCancelOrder, marketplaceCancelReasons, marketplaceCancelRejectReasons, marketplaceDecideCancel } from './service/order-actions.ts';
// Thao tác yêu cầu trả trên sàn cho `order` (#202), tiêm qua `ctx.marketplaceReturns`.
export { marketplaceReturns } from './service/return-actions.ts';
// Tách kiện, giao kiện trên sàn cho fulfillment (#221; #205, #239 gọi), tiêm qua `ctx.marketplacePackages` ở `src/wiring.ts`.
export {
  marketplaceCarriers, marketplacePack, marketplaceReadyToShip, marketplaceRepack, marketplaceShipPackage,
  marketplaceShippingDocuments, marketplaceSplitAttributes, marketplaceSplitLevel, marketplaceSplitOrder,
} from './service/order-actions.ts';
import { verifyMarketplaces } from './service/marketplace-check.ts';
