// Đổi trạng thái tiền một bước, chỉ finance (#27) gọi (plan chuẩn bị A11): finance điều phối luồng nhiều bước
// (phiếu thu, phiếu chi, đảo chứng từ), payment giữ trạng thái. Trạng thái nguồn lệch thì
// `AppError(409, 'payment_state_changed')` kèm `current`. Gọi trong `withCompany` sau khi đã khoá dòng đơn (A4).
import { AppError, notImplemented } from '../../../shared/errors/app-error.ts';
import { initialPaymentStatus } from '../domain/order-payment.ts';
import { findOrderPayment, insertOrderPaymentIfMissing, updateOrderPayment } from '../repository/order-payments.ts';
import { markLinkPaid } from '../repository/payment-links.ts';
import { getOrdersForFinance } from '../../sales/index.ts';
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

/**
 * Xác nhận đã nhận tiền COD cho cả lô (T18): mọi đơn phải `cod_pending` **và đã giao**, một đơn lệch thì 409
 * `payment_state_changed` kèm `orders: [{ orderId, code, status }]` các đơn lệch, không đơn nào đổi. Khoá `order_payments`
 * theo thứ tự `order_id` để hai lô chồng nhau không deadlock; bên gọi đã khoá dòng đơn trước (A4). Đơn không thấy → 404.
 */
export async function markCodCollected(orderIds: readonly string[]): Promise<OrderPaymentState[]> {
  requireCompany('markCodCollected');
  const ids = [...new Set(orderIds)].toSorted();
  const orders = await getOrdersForFinance(ids);
  if (orders.size !== ids.length) throw new AppError(404, 'not_found', 'Không tìm thấy đơn hàng');
  const rows = [];
  for (const id of ids) rows.push({ id, row: await findOrderPayment(id, 'update') });
  const blocked = rows.filter(({ row }) => row?.status !== 'cod_pending' || !row.deliveredAt);
  if (blocked.length > 0) {
    throw new AppError(409, 'payment_state_changed', 'Có đơn không còn chờ thu COD hoặc chưa giao; cả lô không đổi', {
      // Mã đơn do finance gắn (payment chỉ giữ trạng thái).
      orders: blocked.map(({ id, row }) => ({
        orderId: id,
        status: row?.status ?? initialPaymentStatus(orders.get(id)!.paymentMethod ?? 'prepaid'),
      })),
    });
  }
  const states: OrderPaymentState[] = [];
  for (const id of ids) {
    const order = orders.get(id)!;
    const updated = await updateOrderPayment(id, { status: 'cod_collected', paidAt: new Date() });
    states.push(stateOf({ id, method: order.paymentMethod ?? 'cod', total: order.total }, updated));
  }
  return states;
}

/** Hoàn tiền `pending_refund` → `refunded` (ghi sổ phiếu chi hoàn tiền). Lệch → 409 `payment_state_changed` kèm `current`. */
export async function markRefunded(orderId: string): Promise<OrderPaymentState> {
  const order = await orderWithPayment(orderId);
  const row = await findOrderPayment(orderId, 'update');
  if (row?.refundStatus !== 'pending_refund') {
    throw new AppError(409, 'payment_state_changed', 'Đơn không ở trạng thái chờ hoàn tiền', { current: stateOf(order, row) });
  }
  return stateOf(order, await updateOrderPayment(orderId, { refundStatus: 'refunded' }));
}

/** Đảo phiếu thu: `paid` → `unpaid`, `cod_collected` → `cod_pending` (UC-PF-09, chưa có issue). */
export async function revertPaid(_orderId: string): Promise<OrderPaymentState> {
  throw notImplemented('revertPaid', 'UC-PF-09');
}

/** Đảo phiếu chi hoàn tiền: `refunded` → `pending_refund` (UC-PF-09, chưa có issue). */
export async function revertRefunded(_orderId: string): Promise<OrderPaymentState> {
  throw notImplemented('revertRefunded', 'UC-PF-09');
}
