// Hàm nguồn cho báo cáo (#29). Gọi trong `withCompany` của bên gọi.
import { Decimal } from 'decimal.js';
import { requireCompanyId } from '../../../shared/db/client.ts';
import { cogsByOrder } from '../repository/daily-totals.ts';

/** Giá vốn hàng đã xuất của từng đơn (tổng `quantity × unit_cost` các phiếu xuất đã ghi sổ); đơn chưa xuất vắng mặt. */
export async function getOrderCogs(orderIds: readonly string[]): Promise<Map<string, Decimal>> {
  requireCompanyId('getOrderCogs');
  return new Map((await cogsByOrder(orderIds)).map((r) => [r.orderId, new Decimal(r.cogs)]));
}
