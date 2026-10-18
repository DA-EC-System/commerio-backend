// Đổi trạng thái tiền một bước, chỉ finance (#27) gọi (plan chuẩn bị A11): finance điều phối luồng nhiều bước
// (phiếu thu, phiếu chi, đảo chứng từ), payment giữ trạng thái. Trạng thái nguồn lệch thì
// `AppError(409, 'payment_state_changed')` kèm `current`. Gọi trong `withCompany` sau khi đã khoá dòng đơn (A4).
import { AppError, notImplemented } from '../../../shared/errors/app-error.ts';
import { initialPaymentStatus } from '../domain/order-payment.ts';
import { findOrderPayment, insertOrderPaymentIfMissing, updateOrderPayment } from '../repository/order-payments.ts';
import { markLinkPaid } from '../repository/payment-links.ts';
import { type OrderPaymentState, orderWithPayment, requireCompany, stateOf } from './boundary.ts';

/** `unpaid` → `paid`, `paid_at` = bây giờ; mã của giao dịch `active`/`expired` → `paid` (§12.2, T15). */
export async function markPaid(
  orderId: string,
  by: { paymentTransactionId: string | null; paymentLinkId: string | null },
): Promise<OrderPaymentState> {
  const order = await orderWithPayment(orderId);
  // Đơn chưa xác nhận mà khách đã trả qua mã: tạo dòng như lúc tạo mã (A8).
  await insertOrderPaymentIfMissing(requireCompany('markPaid'), orderId, initialPaymentStatus(order.method));
  const row = await findOrderPayment(orderId, 'update');
  if (row?.status !== 'unpaid') {
    throw new AppError(409, 'payment_state_changed', 'Đơn không còn ở trạng thái chưa thu', { current: stateOf(order, row) });
  }
  const updated = await updateOrderPayment(orderId, { status: 'paid', paidAt: new Date() });
  if (by.paymentLinkId) await markLinkPaid(by.paymentLinkId);
  return stateOf(order, updated);
}

/** `cod_pending` → `cod_collected` cho cả lô, một đơn lệch thì không đơn nào đổi (T18). PR3 của #27. */
export async function markCodCollected(_orderIds: readonly string[]): Promise<OrderPaymentState[]> {
  throw notImplemented('markCodCollected', '#27');
}

/** Hoàn tiền `pending_refund` → `refunded`. PR3 của #27. */
export async function markRefunded(_orderId: string): Promise<OrderPaymentState> {
  throw notImplemented('markRefunded', '#27');
}

/** Đảo phiếu thu: `paid` → `unpaid`, `cod_collected` → `cod_pending` (UC-PF-09, chưa có issue). */
export async function revertPaid(_orderId: string): Promise<OrderPaymentState> {
  throw notImplemented('revertPaid', 'UC-PF-09');
}

/** Đảo phiếu chi hoàn tiền: `refunded` → `pending_refund` (UC-PF-09, chưa có issue). */
export async function revertRefunded(_orderId: string): Promise<OrderPaymentState> {
  throw notImplemented('revertRefunded', 'UC-PF-09');
}
