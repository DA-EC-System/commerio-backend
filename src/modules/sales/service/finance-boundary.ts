// Đọc đơn cho finance, payment (plan #27 A2, Thành duyệt 18/10): dòng đơn để lập hoá đơn, thông tin đơn theo lô cho
// các danh sách tài chính. Sales không gọi payment, finance (R1). Gọi trong `withCompany` của bên gọi; đơn công ty
// khác không thấy qua RLS.
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { findOrderLines, findOrdersForFinance } from '../repository/orders-for-finance.ts';
import type { OrderSource, OrderStatus, PaymentMethod } from './payment-boundary.ts';

export interface OrderLineForInvoice {
  id: string;
  variantId: string;
  sku: string;
  productName: string;
  quantity: number;
  unitPrice: Decimal;
  lineTotal: Decimal;
}

export interface OrderForFinance {
  id: string;
  code: string;
  status: OrderStatus;
  source: OrderSource;
  paymentMethod: PaymentMethod | null;
  total: Decimal;
  customerName: string | null;
  customerPhone: string | null;
}

const isUuid = (id: string) => z.uuid().safeParse(id).success;

/** Dòng đơn (SKU, tên, đơn giá đã chép lúc tạo đơn), theo thứ tự tạo. Đơn không thấy → mảng rỗng. */
export async function getOrderLines(orderId: string): Promise<OrderLineForInvoice[]> {
  if (!isUuid(orderId)) return [];
  const rows = await findOrderLines(orderId);
  return rows.map((r) => ({ ...r, unitPrice: new Decimal(r.unitPrice), lineTotal: new Decimal(r.lineTotal) }));
}

/** Đơn theo lô; id không thấy (không có, công ty khác, sai định dạng) không có trong kết quả. */
export async function getOrdersForFinance(ids: readonly string[]): Promise<Map<string, OrderForFinance>> {
  const valid = [...new Set(ids)].filter(isUuid);
  if (valid.length === 0) return new Map();
  const rows = await findOrdersForFinance(valid);
  return new Map(rows.map((r) => [r.id, { ...r, total: new Decimal(r.total) }]));
}
