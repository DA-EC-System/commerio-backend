// Hàm nguồn cho báo cáo (#29, plan chuẩn bị 4.5): chỉ #29 viết thân ở file này, không sửa inventory/index.ts.
import type { Decimal } from 'decimal.js';
import { notImplemented } from '../../../shared/errors/app-error.ts';

/** Giá vốn hàng đã xuất của từng đơn (tổng `quantity × unit_cost` các phiếu xuất đã ghi sổ). */
export async function getOrderCogs(_orderIds: readonly string[]): Promise<Map<string, Decimal>> {
  throw notImplemented('getOrderCogs', '#29');
}
