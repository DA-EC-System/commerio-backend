// API công khai của module `finance`: hoá đơn, phiếu thu, phiếu chi, khoản thu chưa khớp, đối soát.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../shared/module.ts';
import { registerFinanceOpenApi } from './api/openapi.ts';
import { financeRouter } from './api/routes.ts';

export const financeModule: ModuleDefinition = {
  name: 'finance',
  router: financeRouter,
  openapi: registerFinanceOpenApi,
};

export { issueInvoiceForOrder, recordCodCollected } from './service/boundary.ts';
export { getDailyFinanceTotals } from './service/daily-totals.ts';
// Tiêm vào payment qua ctx.onVerifiedPayment ở src/wiring.ts (A11): finance → payment một chiều.
export { handleVerifiedPayment } from './service/verified-payment.ts';
// Tiêm vào payment qua ctx.financeRefsOf (#27 A21): phiếu thu của giao dịch cổng.
export { getTransactionRefs } from './service/transaction-refs.ts';
