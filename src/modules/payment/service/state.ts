// Đổi trạng thái tiền một bước, chỉ finance (#27) gọi (plan chuẩn bị A11): finance điều phối luồng nhiều bước
// (phiếu thu, phiếu chi, đảo chứng từ), payment giữ trạng thái. Trạng thái nguồn lệch thì
// `AppError(409, 'payment_state_changed')` kèm `current`. #27 viết thân ở file này.
import { notImplemented } from '../../../shared/errors/app-error.ts';
import type { OrderPaymentState } from './boundary.ts';

/** `unpaid` → `paid`; mã `active` hoặc `expired` của giao dịch → `paid`. */
export async function markPaid(
  _orderId: string,
  _by: { paymentTransactionId: string | null; paymentLinkId: string | null },
): Promise<OrderPaymentState> {
  throw notImplemented('markPaid', '#27');
}

/** `cod_pending` → `cod_collected` cho cả lô, một đơn lệch thì không đơn nào đổi (T18). */
export async function markCodCollected(_orderIds: readonly string[]): Promise<OrderPaymentState[]> {
  throw notImplemented('markCodCollected', '#27');
}

/** Hoàn tiền `pending_refund` → `refunded`. */
export async function markRefunded(_orderId: string): Promise<OrderPaymentState> {
  throw notImplemented('markRefunded', '#27');
}

/** Đảo phiếu thu: `paid` → `unpaid`, `cod_collected` → `cod_pending`. */
export async function revertPaid(_orderId: string): Promise<OrderPaymentState> {
  throw notImplemented('revertPaid', '#27');
}

/** Đảo phiếu chi hoàn tiền: `refunded` → `pending_refund`. */
export async function revertRefunded(_orderId: string): Promise<OrderPaymentState> {
  throw notImplemented('revertRefunded', '#27');
}
