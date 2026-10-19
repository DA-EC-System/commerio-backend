// API công khai của module `payment`: mã thanh toán, giao dịch, trạng thái thanh toán của đơn, cấu hình cổng.
// Module khác chỉ được import từ file này. Payment gọi sales, không gọi finance (finance → payment, A11).
import type { ModuleDefinition } from '../../shared/module.ts';
import { registerPaymentOpenApi } from './api/openapi.ts';
import { paymentRouter } from './api/routes.ts';
import { startPaymentBackground } from './service/overdue-query.ts';

export const paymentModule: ModuleDefinition = {
  name: 'payment',
  router: paymentRouter,
  openapi: registerPaymentOpenApi,
  // Tra cứu quá hạn mỗi 60 giây trong worker (§12.4, #27 A8).
  startBackground: startPaymentBackground,
};

export {
  cancelActiveLink,
  type Gateway,
  getOrderPayments,
  initOrderPayment,
  type ListedOrderPayment,
  listOrderPayments,
  markCodNotCollected,
  markDelivered,
  markRefundPending,
  type OrderPaymentState,
  type PaymentStatus,
  type RefundStatus,
} from './service/boundary.ts';
export { getDailyPaymentFees } from './service/daily-totals.ts';
// Đọc cho finance (#27 A3): `current: OrderPayment` của 409, cổng của phiếu thu, khoản thu chưa khớp.
export { getOrderPaymentView, type OrderPaymentView } from './service/payment-links.ts';
export { getPaymentTransactions } from './service/transactions.ts';
export { markCodCollected, markPaid, markRefunded, revertPaid, revertRefunded } from './service/state.ts';
// Webhook giao cho finance qua ctx (A11): payment không import finance, src/wiring.ts tiêm `onVerifiedPayment`.
export {
  type PaymentContext,
  recordGatewayTransaction,
  type TransactionRefsLookup,
  type VerifiedGatewayPayment,
  type VerifiedPaymentHandler,
  verifiedPaymentHandlerOf,
} from './service/webhook-handler.ts';
