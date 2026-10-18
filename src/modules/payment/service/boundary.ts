// Khung cho fulfillment (#25) và finance (#27) gọi (plan chuẩn bị 4.5, A8, R1, R2; Documents/21 §11, D15):
// #23, #27 viết thân ở file này, không sửa payment/index.ts. Gọi trong `withCompany` của bên gọi.
import type { Decimal } from 'decimal.js';
import { currentCompanyId } from '../../../shared/db/client.ts';
import { notImplemented } from '../../../shared/errors/app-error.ts';
import type { PaymentMethod } from '../../sales/index.ts';
import { findOrderPayment, insertOrderPaymentIfMissing } from '../repository/order-payments.ts';
import { cancelActiveLinks } from '../repository/payment-links.ts';
import type { gateway, paymentStatus, refundStatus } from '../repository/schema.ts';

export type Gateway = (typeof gateway.enumValues)[number];
export type PaymentStatus = (typeof paymentStatus.enumValues)[number];
export type RefundStatus = (typeof refundStatus.enumValues)[number];

/** Trạng thái tiền của một đơn; `method`, `amount` lấy từ đơn (`sales.getOrderForPayment`). */
export interface OrderPaymentState {
  orderId: string;
  method: PaymentMethod;
  status: PaymentStatus;
  refundStatus: RefundStatus;
  amount: Decimal;
  paidAt: Date | null;
}

// — fulfillment (#25) gọi

/** Tạo dòng trạng thái tiền khi xác nhận đơn: `unpaid` (trả trước) hoặc `cod_pending`. Gọi lại không đổi gì. */
export async function initOrderPayment(orderId: string, method: PaymentMethod): Promise<void> {
  const companyId = currentCompanyId();
  if (!companyId) throw new Error('initOrderPayment phải gọi trong withCompany của bên gọi');
  await insertOrderPaymentIfMissing(companyId, orderId, method === 'cod' ? 'cod_pending' : 'unpaid');
}

/**
 * Huỷ mã `active` của đơn (huỷ đơn, QT-36), trong giao dịch của bên gọi. Bên gọi đổi `sales.orders` **trước** rồi mới gọi
 * hàm này: tạo mã khoá dòng đơn trước rồi tới `order_payments`, cùng thứ tự thì không deadlock và không chèn mã cho đơn
 * vừa huỷ (plan #23 A7). Không gọi API huỷ của cổng (ba cổng không có API huỷ đơn chưa trả, A14).
 */
export async function cancelActiveLink(orderId: string): Promise<void> {
  await findOrderPayment(orderId, 'update');
  await cancelActiveLinks(orderId);
}

/** Huỷ đơn đã thu tiền: hoàn tiền `none` → `pending_refund`. */
export async function markRefundPending(_orderId: string): Promise<OrderPaymentState> {
  throw notImplemented('markRefundPending', '#27');
}

/** Giao COD không thành công: `cod_pending` → `not_collected`. */
export async function markCodNotCollected(_orderId: string): Promise<OrderPaymentState> {
  throw notImplemented('markCodNotCollected', '#27');
}

/** Đơn giao xong: ghi `order_payments.delivered_at`, tab COD lọc theo ngày giao (R2). */
export async function markDelivered(_orderId: string, _at: Date): Promise<void> {
  throw notImplemented('markDelivered', '#27');
}

// — chỉ finance (#27) gọi; sales không gọi payment (R1)

/** Trạng thái tiền của nhiều đơn; đơn không có dòng (đơn sàn) không có trong kết quả. */
export async function getOrderPayments(_orderIds: readonly string[]): Promise<Map<string, OrderPaymentState>> {
  throw notImplemented('getOrderPayments', '#27');
}
