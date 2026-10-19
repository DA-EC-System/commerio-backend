// Đọc đơn cho finance, payment (plan #27 A2, Thành duyệt 18/10): dòng đơn để lập hoá đơn, thông tin đơn theo lô cho
// các danh sách tài chính. Sales không gọi payment, finance (R1). Gọi trong `withCompany` của bên gọi; đơn công ty
// khác không thấy qua RLS.
import { Decimal } from 'decimal.js';
import { isUuid } from '../../../shared/uuid.ts';
import { findOrderLines, findOrdersByExternalId, findOrdersForFinance } from '../repository/orders-for-finance.ts';
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

/**
 * Đơn sàn theo mã đơn của sàn trong một gian hàng (đối soát #30, A6), khoá theo unique (công ty, gian hàng, mã đơn
 * sàn). Mã không thấy (không có, gian hàng khác, công ty khác) không có trong kết quả.
 */
export async function findMarketplaceOrders(
  shopId: string,
  externalOrderIds: readonly string[],
): Promise<Map<string, { id: string; total: Decimal }>> {
  const codes = [...new Set(externalOrderIds)];
  if (!isUuid(shopId) || codes.length === 0) return new Map();
  const rows = await findOrdersByExternalId(shopId, codes);
  return new Map(rows.map((r) => [r.externalOrderId!, { id: r.id, total: new Decimal(r.total) }]));
}
