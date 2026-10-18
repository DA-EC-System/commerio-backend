// Kết quả cổng → ghi gì (Documents/21 §12.4, T15, T16; plan #27 A4). Thuần, không I/O.
import type { Decimal } from 'decimal.js';

export type UnmatchedReason = 'no_payment_code' | 'amount_mismatch' | 'order_cancelled';

export type PaymentDecision =
  | { kind: 'failed' }
  | { kind: 'receipt' }
  | { kind: 'unmatched'; reason: UnmatchedReason };

/**
 * Cổng báo thất bại → `failed`. Không tìm được đơn (SePay không mã) → `no_payment_code`. Đơn huỷ → `order_cancelled`.
 * Đơn không còn `unpaid` (đã trả bằng mã khác, COD) hoặc số tiền khác tổng đơn → `amount_mismatch`. Còn lại → phiếu thu.
 */
export function decidePayment(input: {
  succeeded: boolean;
  amount: Decimal;
  order: { status: string; total: Decimal; paymentStatus: string } | null;
}): PaymentDecision {
  if (!input.succeeded) return { kind: 'failed' };
  const { order } = input;
  if (!order) return { kind: 'unmatched', reason: 'no_payment_code' };
  if (order.status === 'cancelled') return { kind: 'unmatched', reason: 'order_cancelled' };
  if (order.paymentStatus !== 'unpaid' || !input.amount.equals(order.total)) {
    return { kind: 'unmatched', reason: 'amount_mismatch' };
  }
  return { kind: 'receipt' };
}
