// API công khai của module `sales`: đơn hàng, kênh nguồn, hồ sơ khách hàng.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../../shared/module.ts';
import { registerSalesOpenApi } from './api/openapi.ts';
import { salesRouter } from './api/routes.ts';
import { startSalesBackground } from './service/complete.ts';
import { registerReturnsOpenApi } from './api/return-openapi.ts';
import { returnsRouter } from './api/return-routes.ts';

export const salesModule: ModuleDefinition = {
  name: 'sales',
  router: salesRouter,
  openapi: registerSalesOpenApi,
  startBackground: startSalesBackground,
};

/** Yêu cầu trả (#202): cùng module con `sales`, gắn riêng tại /api/v1/returns theo Documents/21 §20. */
export const returnsModule: ModuleDefinition = {
  name: 'returns',
  router: returnsRouter,
  openapi: registerReturnsOpenApi,
};

export {
  getOrderForPayment,
  type OrderForPayment,
  type OrderSource,
  type OrderStatus,
  type PaymentMethod,
} from './service/payment-boundary.ts';
export {
  findMarketplaceOrders,
  getOrderLines,
  getOrdersForFinance,
  type OrderForFinance,
  type OrderLineForInvoice,
} from './service/finance-boundary.ts';
export { getOrderChannels } from './service/daily-totals.ts';
// Ngắt gian hàng (#207): channel đếm đơn chưa xong trong giao dịch ngắt; số đơn trên bảng gian hàng (#200 §18.7).
export {
  countOpenOrders,
  oldestOpenOrders,
  type OpenOrderRef,
  orderCountsByShop,
  purgeShopOrders,
  shopOrderRefs,
} from './service/channel-boundary.ts';
// Nhận đơn sàn (#105): channel kéo đơn gọi trong `withCompany`.
export { ingestMarketplaceOrder, type PlatformOrder, settleCancelledOrder } from './service/ingest.ts';
// Ghép SKU áp lên đơn đã về (spec 237): channel gọi trong giao dịch ghép.
export { applySkuMapping, type ApplySkuMappingInput } from './service/sku-mapping.ts';
export type { SalesContext } from './service/orders.ts';
export { nextPackageCode, orderRefsOf } from './service/package-orders.ts';
// Số bán 30 ngày của SKU cho gợi ý ngưỡng tồn khi sửa hàng loạt (#242); product (lớp dưới) nhận qua `src/wiring.ts`.
export { soldQtyByVariant as soldQtyOf } from './repository/orders.ts';
// Chi tiết đơn cho route tách kiện của fulfillment (spec 205 D9), tiêm qua `FulfillmentContext.orderViewOf`.
export { getOrder } from './service/orders.ts';
export { completeDueOrdersOnce } from './service/complete.ts';
// Yêu cầu trả (#202, Documents/21 §11.3).
export { hasOpenReturns } from './service/return-boundary.ts';
// Lý do chặn lưu trữ SKU phần đơn cho catalog (#204), tiêm qua `ctx.orderArchiveBlockers` ở `src/wiring.ts`.
export { orderArchiveBlockers, orderInUse } from './service/catalog-boundary.ts';
export type { MarketplaceReturns } from './service/marketplace-returns.ts';
// Yêu cầu trả từ sàn (#202): channel kéo về gọi trong `withCompany`.
export { ingestMarketplaceReturn, type PlatformReturn, type ReturnIngestOutcome } from './service/return-ingest.ts';
// Thử lại báo sàn đã nhận hàng trả (§20.1): channel gọi sau mỗi lượt kéo yêu cầu trả.
export {
  flagRefundApprovalFailed,
  markRefundApproved,
  markReturnConfirmed,
  type ReturnToConfirm,
  returnsAwaitingConfirm,
  returnsAwaitingRefundApproval,
} from './service/return-confirm.ts';
// Ghi hoàn tiền tới mức doanh thu đã ghi (#355, Documents/21 §11.3): finance gọi khi nhận `sales.return_refunded`.
export { flagReturnForReview, returnLinesOf, type ReturnLineRef } from './service/return-review.ts';
