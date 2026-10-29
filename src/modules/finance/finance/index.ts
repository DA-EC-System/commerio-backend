// API công khai của module `finance`: hoá đơn, phiếu thu, phiếu chi, khoản thu chưa khớp, đối soát.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../../shared/module.ts';
import { registerFinanceOpenApi } from './api/openapi.ts';
import { financeRouter } from './api/routes.ts';
import { startFinanceBackground } from './service/background.ts';

export const financeModule: ModuleDefinition = {
  name: 'finance',
  router: financeRouter,
  openapi: registerFinanceOpenApi,
  startBackground: startFinanceBackground,
};

// Sổ tiền (#116) chọn phiên bản cấu hình theo ngày kiện giao.
export { getEffectiveConfig } from './service/config-versions.ts';
// Ghi sổ theo sự kiện (#116, Documents/21 §11.2). Đăng ký consumer khi #106, #107, #112 thêm loại sự kiện vào danh mục.
export {
  type PackageDelivered,
  type PackageReturned,
  recordPackageDelivered,
  recordPackageReturned,
  recordReturnInspected,
  recordReturnRefunded,
  type ReturnInspected,
  type ReturnRefunded,
} from './service/ledger.ts';

export { issueInvoiceForOrder, recordCodCollected } from './service/boundary.ts';
export { getDailyFinanceTotals } from './service/daily-totals.ts';
// Tiêm vào payment qua ctx.onVerifiedPayment ở src/modules/finance/index.ts (A11): finance → payment một chiều.
export { handleVerifiedPayment } from './service/verified-payment.ts';
// Tiêm vào payment qua ctx.financeRefsOf (#27 A21): phiếu thu của giao dịch cổng.
export { getTransactionRefs } from './service/transaction-refs.ts';
// Tên gian hàng cho đối soát (#30 A7): src/wiring.ts tiêm channel.getShops qua ctx.shopsOf.
export type { FinanceContext, ShopInfo } from './service/settlement-views.ts';
