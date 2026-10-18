// Khung cho payment, finance đọc đơn (plan chuẩn bị 4.5, A8; Documents/21 §11): #23 viết thân ở file này,
// không sửa sales/index.ts. Sales không gọi payment (R1). Gọi trong `withCompany` của bên gọi.
import type { Decimal } from 'decimal.js';
import { notImplemented } from '../../../shared/errors/app-error.ts';
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

/** Đơn để tạo mã, ghi nhận tiền; `null` khi không thấy (không có, hoặc của công ty khác qua RLS) → bên gọi trả 404. */
export async function getOrderForPayment(_orderId: string): Promise<OrderForPayment | null> {
  throw notImplemented('getOrderForPayment', '#23');
}
