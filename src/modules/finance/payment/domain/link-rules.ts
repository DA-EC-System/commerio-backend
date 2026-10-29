// Luật được tạo mã thanh toán (Documents/21 §12.9 `payment_not_allowed`; plan #23 A9). Thuần, không I/O.
// Trả câu lý do (đưa vào `detail` của 409) hoặc `null` khi được tạo.
import type { Decimal } from 'decimal.js';
import type { Gateway } from './gateways.ts';

export interface OrderFacts {
  /** Trống với đơn sàn (19-D11). */
  paymentMethod: 'prepaid' | 'cod' | null;
  /** Trạng thái duyệt đơn (`"order".orders.status`). */
  status: string;
  /** Trạng thái tiền (`finance.order_payments.status`, hoặc suy từ đơn khi chưa có dòng). */
  paymentStatus: string;
  total: Decimal;
}

/** Luật theo đơn, kiểm trước khi trả mã còn hạn và kiểm lại lúc ghi mã. */
export function orderBlockReason(order: OrderFacts): string | null {
  if (order.paymentMethod === null) return 'Đơn sàn do sàn thu hộ, không tạo mã thanh toán';
  if (order.paymentMethod === 'cod') return 'Đơn thu tiền khi giao (COD), không tạo mã thanh toán';
  if (order.status === 'cancelled') return 'Đơn đã huỷ';
  if (order.paymentStatus !== 'unpaid') return 'Đơn đã thanh toán';
  if (!order.total.isInteger() || order.total.lte(0)) return 'Tổng đơn phải là số nguyên đồng lớn hơn 0';
  return null;
}

/** Hạn mức tiền của MoMo, gồm hai đầu (đo trên sandbox 18/10/2026: 999 và 50.000.001 bị từ chối). */
const MOMO_MIN = 1_000;
const MOMO_MAX = 50_000_000;

/** Luật theo cổng, chỉ kiểm khi phải tạo mã mới (sau bước trả mã còn hạn). */
export function gatewayBlockReason(gateway: Gateway, total: Decimal): string | null {
  if (gateway === 'momo' && (total.lt(MOMO_MIN) || total.gt(MOMO_MAX))) {
    return 'MoMo chỉ nhận số tiền từ 1.000 đến 50.000.000 đồng; chọn cổng khác';
  }
  return null;
}
