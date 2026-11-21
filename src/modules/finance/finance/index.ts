// API công khai của module `finance`: sổ tiền, trạng thái tiền của đơn, đối soát, phiên bản cấu hình.
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
// Bộ lọc giá theo gian hàng của channel (#225) đọc phí, thuế, lãi tối thiểu đang áp dụng.
export { type ConfigPayload, feePctOf, feeRoundingOf, vnDate } from './domain/config-version.ts';
// Biểu phí mẫu (Documents/21 §21.6): route quản trị nền tảng ở core/platform nhận các hàm này qua `src/wiring.ts`.
export { createFeeTemplate, type FeeTemplateDeps, type FeeTemplateView, listPlatformFeeTemplates, updateFeeTemplate } from './service/fee-templates.ts';
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
  recordGoodsReceiptPosted,
  type ReturnInspected,
  type ReturnRefunded,
  type SupplierReturnRefunded,
} from './service/ledger.ts';

// Số liệu trang Tổng quan của insight (#333, Documents/21 §21.5): gom sổ theo ngày, gian hàng.
export { type DailyFigureRow, getDailyLedgerFigures } from './service/daily-figures.ts';

// Trạng thái tiền theo đơn cho `OrderSummary.paymentStatus` của sales (#234): src/wiring.ts tiêm qua ctx.paymentStatusOf.
export { paymentStatusesOf } from './service/order-settlement-state.ts';

// Tiêm vào payment qua ctx.onVerifiedPayment ở src/modules/finance/index.ts (A11): finance → payment một chiều.
export { handleVerifiedPayment } from './service/verified-payment.ts';
// Tên gian hàng cho đối soát (#30 A7): src/wiring.ts tiêm channel.getShops qua ctx.shopsOf.
export type { FinanceContext, ShopInfo } from './service/settlement-views.ts';
// Lệch ví của lần đối soát gần nhất có số, cho `Shop.walletMismatch` của channel (#251, Documents/21 §11.3).
export { walletDiffOf } from './service/settlement-runs.ts';
// Xoá gian hàng đã ngắt (#398): channel đếm dữ liệu tiền để chặn, rồi xoá đối soát `none`, cấu hình phí của gian hàng.
export { type FinanceDataCounts, hasFinanceData, purgeShopFinance, shopFinanceData } from './service/shop-purge.ts';
