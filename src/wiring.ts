// Nối các module lúc khởi động (plan chuẩn bị A1, K4): hàm một module cần từ module khác mà import thẳng
// sẽ ngược lớp hoặc thành vòng thì đi qua `ModuleContext`. Chỉ import `index.ts` của module.
import type { CatalogContext } from './modules/catalog/index.ts';
import { getTransactionRefs, handleVerifiedPayment } from './modules/finance/index.ts';
import { loadCompanyAccess } from './modules/identity/index.ts';
import type { PaymentContext } from './modules/payment/index.ts';
import { getStandardPrices } from './modules/pricing/index.ts';
import { createAuthorize } from './shared/auth/authorize.ts';
import type { ModuleContext } from './shared/module.ts';

/** Đủ mọi trường mà các module khai trong kiểu `ctx` của mình; quên tiêm một hàm là lỗi kiểu ở đây. */
export type AppContext = ModuleContext &
  Required<Pick<CatalogContext, 'standardPrices'>> &
  Required<Pick<PaymentContext, 'onVerifiedPayment' | 'financeRefsOf'>>;

export function createModuleContext(): AppContext {
  return {
    authorize: createAuthorize(loadCompanyAccess),
    // A12: catalog lấy giá chuẩn (V22) mà không import pricing.
    standardPrices: getStandardPrices,
    // A11: webhook của payment giao cho finance mà payment không import finance.
    onVerifiedPayment: handleVerifiedPayment,
    // #27 A21: phiếu thu, khoản thu chưa khớp của giao dịch cổng nằm ở finance.
    financeRefsOf: getTransactionRefs,
  };
}
