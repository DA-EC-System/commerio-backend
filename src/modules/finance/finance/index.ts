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
// Loại khoản trong sổ: adapter sàn của channel điền `kind` cho khoản quyết toán (#203).
export { LEDGER_KINDS, type LedgerKind } from './domain/ledger.ts';
// Ghi sổ theo sự kiện (#116, Documents/21 §11.2); consumer `finance-ledger` đăng ký ở startFinanceBackground (#228).
export {
  type PackageDelivered,
  type PackageReturned,
  recordPackageDelivered,
  recordPackageReturned,
  recordReturnInspected,
  recordReturnRefunded,
  recordSupplierReturnRefunded,
  type ReturnInspected,
  type ReturnRefunded,
  type SupplierReturnRefunded,
} from './service/ledger.ts';

// Trạng thái tiền theo đơn cho `OrderSummary.paymentStatus` của sales (#234): src/wiring.ts tiêm qua ctx.paymentStatusOf.
export { paymentStatusesOf } from './service/order-settlement-state.ts';

export { issueInvoiceForOrder, recordCodCollected } from './service/boundary.ts';
export { getDailyFinanceTotals } from './service/daily-totals.ts';
// Tiêm vào payment qua ctx.onVerifiedPayment ở src/modules/finance/index.ts (A11): finance → payment một chiều.
export { handleVerifiedPayment } from './service/verified-payment.ts';
// Tiêm vào payment qua ctx.financeRefsOf (#27 A21): phiếu thu của giao dịch cổng.
export { getTransactionRefs } from './service/transaction-refs.ts';
// Tên gian hàng cho đối soát (#30 A7): src/wiring.ts tiêm channel.getShops qua ctx.shopsOf.
export type { FinanceContext, ShopInfo } from './service/settlement-views.ts';
// Lệch ví của lần đối soát gần nhất có số, cho `Shop.walletMismatch` của channel (#251, Documents/21 §11.3).
export { walletDiffOf } from './service/settlement-runs.ts';
