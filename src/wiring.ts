// Nối các module lớn lúc khởi động (plan chuẩn bị A1, K4): hàm một module lớn cần từ module lớn khác mà import thẳng
// sẽ ngược lớp hoặc thành vòng thì đi qua `ModuleContext`. Chỉ import `index.ts` của module lớn. Nối giữa hai module
// con cùng module lớn đặt trong index.ts của module lớn đó (vd `paymentContext` của finance).
import {
  awaitingStocktakeShops,
  getShops,
  hasInboxData,
  listingArchiveBlockers,
  listingInUse,
  listingPresenceOf,
  marketplaceCancelOrder,
  marketplaceCancelReasons,
  marketplaceCancelRejectReasons,
  marketplaceCarriers,
  marketplaceDecideCancel,
  marketplacePack,
  marketplaceReadyToShip,
  marketplaceRepack,
  marketplaceReturns,
  marketplaceShipPackage,
  marketplaceShippingDocuments,
  marketplaceSplitAttributes,
  marketplaceSplitLevel,
  marketplaceSplitOrder,
  knownPlatformCategories,
  returnPoliciesOf,
  settlementPayouts,
  settlementTransactions,
  shopsToSettle,
} from './modules/channel/index.ts';
import { type IdentityContext, loadCompanyAccess, type PlatformContext } from './modules/core/index.ts';
import { type FinanceContext, paymentStatusesOf } from './modules/finance/index.ts';
import { hasAssistantData } from './modules/insight/index.ts';
import { type FulfillmentContext, orderArchiveBlockers, orderInUse, type SalesContext, soldQtyOf } from './modules/order/index.ts';
import { type CatalogContext, hasPurchasingData, seedCompanyDefaults } from './modules/product/index.ts';
import { createAuthorize, createMember } from './shared/auth/authorize.ts';
import type { ModuleContext } from './shared/module.ts';

/** Đủ mọi trường mà các module khai trong kiểu `ctx` của mình; quên tiêm một hàm là lỗi kiểu ở đây. */
export type AppContext = ModuleContext &
  Required<Pick<FinanceContext, 'shopsOf' | 'settlementSource' | 'knownPlatformCategories'>> &
  Required<Pick<SalesContext, 'shopsOf' | 'marketplaceOrders' | 'marketplaceReturns' | 'paymentStatusOf' | 'returnPoliciesOf'>> &
  Required<Pick<FulfillmentContext, 'shopsOf' | 'stockHoldOf' | 'marketplacePackages'>> &
  Required<Pick<PlatformContext, 'moduleData'>> &
  Required<Pick<IdentityContext, 'seedCompanyDefaults'>> & { soldQtyOf: typeof soldQtyOf } &
  Required<Pick<CatalogContext, 'orderArchiveBlockers' | 'listingArchiveBlockers' | 'listingPresenceOf' | 'orderInUse' | 'listingInUse'>>;

/** Dữ liệu có sẵn của công ty mới. Ánh xạ sang sàn của dữ liệu chuẩn là dòng nền tảng dùng chung, không chép. Dùng cả ở seed demo. */
export async function seedNewCompany(companyId: string): Promise<void> {
  await seedCompanyDefaults(companyId);
}

export function createModuleContext(): AppContext {
  return {
    authorize: createAuthorize(loadCompanyAccess),
    member: createMember(loadCompanyAccess),
    // #30 A7: finance (lớp dưới) cần tên gian hàng của channel cho bảng kê đối soát; #105: sales cho danh sách đơn.
    shopsOf: getShops,
    // #117: finance kéo quyết toán qua token gian hàng của channel.
    settlementSource: { transactions: settlementTransactions, payouts: settlementPayouts, shops: shopsToSettle },
    // #105 PR 2: sales (lớp dưới) huỷ đơn, trả lời khách xin huỷ trên sàn qua token gian hàng của channel.
    marketplaceOrders: {
      cancelReasons: marketplaceCancelReasons, cancel: marketplaceCancelOrder, decideCancel: marketplaceDecideCancel,
      cancelRejectReasons: marketplaceCancelRejectReasons,
    },
    // #202: sales xử lý yêu cầu trả trên sàn (chấp nhận, từ chối, hoàn tiền, báo đã nhận) qua token của channel.
    marketplaceReturns,
    // #234: sales (lớp dưới) trả `paymentStatus` của đơn theo sổ tiền của finance, không đọc bảng finance.
    paymentStatusOf: paymentStatusesOf,
    // #236: sales (lớp dưới) tính hạn trả theo cấu hình gian hàng của channel.
    returnPoliciesOf,
    // Phí sàn theo category (Documents/21 §21.4): finance kiểm category của `categoryRates` trong cây của channel.
    knownPlatformCategories,
    // #199 phần b: fulfillment (lớp dưới) cần biết gian hàng còn chờ kiểm kê đầu kỳ để hoãn trừ, bỏ qua khi phân hàng.
    stockHoldOf: awaitingStocktakeShops,
    // #221: fulfillment tách kiện (#205), báo sẵn sàng giao (#239) trên sàn qua token gian hàng của channel.
    // #205: `splitLevel` cho fulfillment rẽ nhánh tách kiện theo năng lực sàn của gian hàng.
    marketplacePackages: {
      splitLevel: marketplaceSplitLevel,
      splitAttributes: marketplaceSplitAttributes, split: marketplaceSplitOrder, ship: marketplaceShipPackage,
      carriers: marketplaceCarriers, pack: marketplacePack, readyToShip: marketplaceReadyToShip,
      repack: marketplaceRepack, shippingDocuments: marketplaceShippingDocuments,
    },
    // #204: catalog (lớp dưới) chặn lưu trữ SKU còn đơn mở, yêu cầu trả mở, listing đang đẩy.
    orderArchiveBlockers,
    listingArchiveBlockers,
    // #204: nhãn hiện diện trên sàn của SKU (D8) ở danh sách, chi tiết sản phẩm.
    listingPresenceOf,
    // #204: SKU đã dùng ở đơn, sàn thì không xoá hẳn sản phẩm.
    orderInUse,
    listingInUse,
    // #242: catalog (lớp dưới) gợi ý ngưỡng tồn theo số bán 30 ngày của sales khi sửa hàng loạt.
    soldQtyOf,
    // #152: phân hệ đã có dữ liệu thì không tắt được. `report` đọc sổ tiền của finance, không có dữ liệu riêng nên không có hàm (luôn tắt được).
    moduleData: { purchasing: hasPurchasingData, inbox: hasInboxData, assistant: hasAssistantData },
    // #447: công ty mới nhận nhóm hàng, thuộc tính chuẩn sàn, cài đặt sản phẩm trong giao dịch đăng ký; #509: sau đó ánh xạ
    // thông số mặc định sang các sàn (channel), cùng giao dịch.
    seedCompanyDefaults: seedNewCompany,
  };
}
