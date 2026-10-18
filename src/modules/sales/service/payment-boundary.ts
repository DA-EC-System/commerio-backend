// Đọc đơn cho payment, finance (plan chuẩn bị 4.5, A8; Documents/21 §11; #23 viết thân). Sales không gọi payment (R1).
// Gọi trong `withCompany` của bên gọi.
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { findOrderForPayment } from '../repository/orders-for-payment.ts';
import type { fulfillmentStatus, orderSource, paymentMethod } from '../repository/schema.ts';

export type OrderStatus = (typeof fulfillmentStatus.enumValues)[number];
export type OrderSource = (typeof orderSource.enumValues)[number];
export type PaymentMethod = (typeof paymentMethod.enumValues)[number];

export interface OrderForPayment {
  id: string;
  code: string;
  status: OrderStatus;
  source: OrderSource;
  /** Trống với đơn sàn (19-D11). */
  paymentMethod: PaymentMethod | null;
  total: Decimal;
  customer: { id: string; name: string | null; phone: string | null; email: string | null } | null;
}

/**
 * Đơn để tạo mã, ghi nhận tiền; `null` khi không thấy (không có, id sai định dạng, hoặc của công ty khác qua RLS) → bên
 * gọi trả 404. `lock: 'share'` khoá dòng đơn tới hết giao dịch (`FOR SHARE`): payment dùng khi ghi mã để không chèn mã
 * cho đơn đang bị huỷ song song (plan #23 A7).
 */
export async function getOrderForPayment(orderId: string, opts?: { lock?: 'share' }): Promise<OrderForPayment | null> {
  if (!z.uuid().safeParse(orderId).success) return null;
  const row = await findOrderForPayment(orderId, opts?.lock);
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    source: row.source,
    paymentMethod: row.paymentMethod,
    total: new Decimal(row.total),
    customer: row.customerId
      ? { id: row.customerId, name: row.customerName, phone: row.customerPhone, email: row.customerEmail }
      : null,
  };
}
