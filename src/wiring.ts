// Nối các module lớn lúc khởi động (plan chuẩn bị A1, K4): hàm một module lớn cần từ module lớn khác mà import thẳng
// sẽ ngược lớp hoặc thành vòng thì đi qua `ModuleContext`. Chỉ import `index.ts` của module lớn. Nối giữa hai module
// con cùng module lớn đặt trong index.ts của module lớn đó (vd `paymentContext` của finance).
import {
  awaitingStocktakeShops,
  getShops,
  hasChannelData,
  hasInboxData,
  marketplaceCancelOrder,
  marketplaceCancelReasons,
  marketplaceCarriers,
  marketplaceDecideCancel,
  marketplacePack,
  marketplaceReadyToShip,
  marketplaceRepack,
  marketplaceReturns,
  marketplaceShipPackage,
  marketplaceShippingDocuments,
  marketplaceSplitAttributes,
  marketplaceSplitOrder,
  settlementPayouts,
  settlementTransactions,
  shopsToSettle,
} from './modules/channel/index.ts';
import { loadCompanyAccess, type PlatformContext } from './modules/core/index.ts';
import { type FinanceContext, paymentStatusesOf } from './modules/finance/index.ts';
import { hasAssistantData } from './modules/insight/index.ts';
import type { FulfillmentContext, SalesContext } from './modules/order/index.ts';
import { hasPurchasingData } from './modules/product/index.ts';
import { createAuthorize } from './shared/auth/authorize.ts';
import type { ModuleContext } from './shared/module.ts';

/** Đủ mọi trường mà các module khai trong kiểu `ctx` của mình; quên tiêm một hàm là lỗi kiểu ở đây. */
export type AppContext = ModuleContext &
  Required<Pick<FinanceContext, 'shopsOf' | 'settlementSource'>> &
  Required<Pick<SalesContext, 'shopsOf' | 'marketplaceOrders' | 'marketplaceReturns' | 'paymentStatusOf'>> &
  Required<Pick<FulfillmentContext, 'shopsOf' | 'stockHoldOf' | 'marketplacePackages'>> &
  Required<Pick<PlatformContext, 'moduleData'>>;

export function createModuleContext(): AppContext {
  return {
    authorize: createAuthorize(loadCompanyAccess),
    // #30 A7: finance (lớp dưới) cần tên gian hàng của channel cho bảng kê đối soát; #105: sales cho danh sách đơn.
    shopsOf: getShops,
    // #117: finance kéo quyết toán qua token gian hàng của channel.
    settlementSource: { transactions: settlementTransactions, payouts: settlementPayouts, shops: shopsToSettle },
    // #105 PR 2: sales (lớp dưới) huỷ đơn, trả lời khách xin huỷ trên sàn qua token gian hàng của channel.
    marketplaceOrders: { cancelReasons: marketplaceCancelReasons, cancel: marketplaceCancelOrder, decideCancel: marketplaceDecideCancel },
    // #202: sales xử lý yêu cầu trả trên sàn (chấp nhận, từ chối, hoàn tiền, báo đã nhận) qua token của channel.
    marketplaceReturns,
    // #234: sales (lớp dưới) trả `paymentStatus` của đơn theo sổ tiền của finance, không đọc bảng finance.
    paymentStatusOf: paymentStatusesOf,
    // #199 phần b: fulfillment (lớp dưới) cần biết gian hàng còn chờ kiểm kê đầu kỳ để hoãn trừ, bỏ qua khi phân hàng.
    stockHoldOf: awaitingStocktakeShops,
    // #221: fulfillment tách kiện (#205), báo sẵn sàng giao (#239) trên sàn qua token gian hàng của channel.
    marketplacePackages: {
      splitAttributes: marketplaceSplitAttributes, split: marketplaceSplitOrder, ship: marketplaceShipPackage,
      carriers: marketplaceCarriers, pack: marketplacePack, readyToShip: marketplaceReadyToShip,
      repack: marketplaceRepack, shippingDocuments: marketplaceShippingDocuments,
    },
    // #152: phân hệ đã có dữ liệu thì không tắt được. `report` chỉ có bảng dựng lại nên không có hàm (luôn tắt được).
    moduleData: { purchasing: hasPurchasingData, channel: hasChannelData, inbox: hasInboxData, assistant: hasAssistantData },
  };
}
