// Nối các module lớn lúc khởi động (plan chuẩn bị A1, K4): hàm một module lớn cần từ module lớn khác mà import thẳng
// sẽ ngược lớp hoặc thành vòng thì đi qua `ModuleContext`. Chỉ import `index.ts` của module lớn. Nối giữa hai module
// con cùng module lớn đặt trong index.ts của module lớn đó (vd `paymentContext` của finance).
import {
  getShops,
  hasChannelData,
  hasInboxData,
  marketplaceCancelOrder,
  marketplaceCancelReasons,
  marketplaceDecideCancel,
  settlementPayouts,
  settlementTransactions,
  shopsToSettle,
} from './modules/channel/index.ts';
import { loadCompanyAccess, type PlatformContext } from './modules/core/index.ts';
import type { FinanceContext } from './modules/finance/index.ts';
import { hasAssistantData } from './modules/insight/index.ts';
import type { SalesContext } from './modules/order/index.ts';
import { hasPurchasingData } from './modules/product/index.ts';
import { createAuthorize } from './shared/auth/authorize.ts';
import type { ModuleContext } from './shared/module.ts';

/** Đủ mọi trường mà các module khai trong kiểu `ctx` của mình; quên tiêm một hàm là lỗi kiểu ở đây. */
export type AppContext = ModuleContext &
  Required<Pick<FinanceContext, 'shopsOf' | 'settlementSource'>> &
  Required<Pick<SalesContext, 'shopsOf' | 'marketplaceOrders'>> &
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
    // #152: phân hệ đã có dữ liệu thì không tắt được. `report` chỉ có bảng dựng lại nên không có hàm (luôn tắt được).
    moduleData: { purchasing: hasPurchasingData, channel: hasChannelData, inbox: hasInboxData, assistant: hasAssistantData },
  };
}
