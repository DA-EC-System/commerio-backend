// Hàm cho fulfillment (#25) và finance (#27) gọi (plan chuẩn bị 4.5, A8, R1, R2; Documents/21 §11, D15, T30):
// gọi trong `withCompany` của bên gọi, đi chung giao dịch của bên gọi.
import type { Decimal } from 'decimal.js';
import { requireCompanyId } from '../../../../shared/db/client.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { getOrderForPayment, getOrdersForFinance, type PaymentMethod } from '../../../order/index.ts';
import { initialPaymentStatus } from '../domain/order-payment.ts';
import {
  findOrderPayment,
  findOrderPayments,
  findOrderPaymentsWhere,
  type OrderPaymentFilter,
  insertOrderPaymentIfMissing,
  type OrderPaymentRow,
  setDeliveredAtIfMissing,
  updateOrderPayment,
} from '../repository/order-payments.ts';
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

export interface PaidOrder {
  id: string;
  method: PaymentMethod;
  total: Decimal;
}

/** Trạng thái từ dòng `order_payments`; đơn chưa xác nhận (chưa có dòng) suy từ phương thức (A8). */
export function stateOf(order: PaidOrder, row: OrderPaymentRow | undefined): OrderPaymentState {
  return {
    orderId: order.id,
    method: order.method,
    status: row?.status ?? initialPaymentStatus(order.method),
    refundStatus: row?.refundStatus ?? 'none',
    amount: order.total,
    paidAt: row?.paidAt ?? null,
  };
}

/** Đơn có trạng thái tiền: đơn sàn (không có phương thức), đơn công ty khác, id lạ → 404. */
export async function orderWithPayment(orderId: string): Promise<PaidOrder> {
  requireCompanyId('mark*');
  const order = await getOrderForPayment(orderId);
  if (!order?.paymentMethod) throw new AppError(404, 'not_found', 'Không tìm thấy đơn hàng có trạng thái thanh toán');
  return { id: order.id, method: order.paymentMethod, total: order.total };
}

const stateChanged =(current: OrderPaymentState, message: string) =>
  new AppError(409, 'payment_state_changed', message, { current });

// — fulfillment (#25) gọi

/** Tạo dòng trạng thái tiền khi xác nhận đơn: `unpaid` (trả trước) hoặc `cod_pending`. Gọi lại không đổi gì. */
export async function initOrderPayment(orderId: string, method: PaymentMethod): Promise<void> {
  await insertOrderPaymentIfMissing(requireCompanyId('initOrderPayment'), orderId, initialPaymentStatus(method));
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

/**
 * Huỷ đơn: đơn đã thu (`paid`) chuyển hoàn tiền `none` → `pending_refund`. Gọi được cho mọi đơn tay/hộp thư khi huỷ (#25
 * không đọc được trạng thái tiền, R1): chưa thu, chưa xác nhận hay đã chờ hoàn thì trả nguyên, không ghi. Chỉ đơn COD đã
 * thu (`cod_collected`, đã giao) là 409. `updated_at` của dòng là thời điểm huỷ cho tab Cần hoàn tiền (plan #27 A11).
 */
export async function markRefundPending(orderId: string): Promise<OrderPaymentState> {
  const order = await orderWithPayment(orderId);
  const row = await findOrderPayment(orderId, 'update');
  const state = stateOf(order, row);
  if (state.status === 'cod_collected') throw stateChanged(state, 'Đơn COD đã thu tiền, không chuyển sang chờ hoàn được');
  if (state.status !== 'paid' || state.refundStatus !== 'none') return state;
  return stateOf(order, await updateOrderPayment(orderId, { refundStatus: 'pending_refund' }));
}

/**
 * Đơn COD không thu được tiền (giao thất bại, hoặc huỷ trước khi giao): `cod_pending` → `not_collected`. Đơn trả trước,
 * đơn chưa xác nhận, đã `not_collected` → trả nguyên. `cod_collected` → 409.
 */
export async function markCodNotCollected(orderId: string): Promise<OrderPaymentState> {
  const order = await orderWithPayment(orderId);
  const row = await findOrderPayment(orderId, 'update');
  const state = stateOf(order, row);
  if (state.status === 'cod_collected') throw stateChanged(state, 'Đơn COD đã thu tiền');
  if (!row || state.status !== 'cod_pending') return state;
  return stateOf(order, await updateOrderPayment(orderId, { status: 'not_collected' }));
}

/** Đơn giao xong: ghi `order_payments.delivered_at` lần đầu, tab COD lọc theo ngày giao (R2). Đơn không có dòng: thôi. */
export async function markDelivered(orderId: string, at: Date): Promise<void> {
  requireCompanyId('markDelivered');
  if (!isUuid(orderId)) return;
  await setDeliveredAtIfMissing(orderId, at);
}

// — chỉ finance (#27) gọi; sales không gọi payment (R1)

/** Trạng thái tiền của nhiều đơn; đơn không có dòng (đơn sàn, chưa xác nhận) không có trong kết quả. */
export async function getOrderPayments(orderIds: readonly string[]): Promise<Map<string, OrderPaymentState>> {
  requireCompanyId('getOrderPayments');
  const valid = orderIds.filter(isUuid);
  const rows = valid.length > 0 ? await findOrderPayments(valid) : [];
  if (rows.length === 0) return new Map();
  const orders = await getOrdersForFinance(rows.map((r) => r.orderId));
  const result = new Map<string, OrderPaymentState>();
  for (const row of rows) {
    const order = orders.get(row.orderId);
    if (order?.paymentMethod) {
      result.set(row.orderId, stateOf({ id: order.id, method: order.paymentMethod, total: order.total }, row));
    }
  }
  return result;
}

/** Trạng thái tiền kèm ngày giao, ngày cập nhật cuối, cho danh sách tài chính (tab COD, Cần hoàn tiền; plan #27 A3). */
export type ListedOrderPayment = OrderPaymentState & { deliveredAt: Date | null; updatedAt: Date };

/** Đơn có dòng trạng thái tiền theo bộ lọc; chỉ finance gọi (R1). Đơn không còn thấy (RLS) bị bỏ. */
export async function listOrderPayments(filter: OrderPaymentFilter): Promise<ListedOrderPayment[]> {
  requireCompanyId('listOrderPayments');
  const rows = await findOrderPaymentsWhere(filter);
  const orders = rows.length > 0 ? await getOrdersForFinance(rows.map((r) => r.orderId)) : new Map();
  return rows.flatMap((row) => {
    const order = orders.get(row.orderId);
    if (!order?.paymentMethod) return [];
    const state = stateOf({ id: order.id, method: order.paymentMethod, total: order.total }, row);
    return [{ ...state, deliveredAt: row.deliveredAt, updatedAt: row.updatedAt }];
  });
}
