// Khung của #16 cho sales (#24) và fulfillment (#25) gọi: chữ ký đã chốt (plan chuẩn bị 4.5, Documents/21 §11),
// #16 viết thân ở file này, không sửa inventory/index.ts. Gọi trong `withCompany` của bên gọi.
import type { Decimal } from 'decimal.js';
import { notImplemented } from '../../../shared/errors/app-error.ts';


export interface StockLine {
  variantId: string;
  quantity: number;
}

/** Giữ hàng cho đơn; dòng thiếu tồn vẫn giữ phần có được và trả trong `shortLines`. */
export async function reserve(
  _orderId: string,
  _lines: readonly StockLine[],
): Promise<{ shortLines: { variantId: string; requested: number; available: number }[] }> {
  throw notImplemented('reserve', '#16');
}

/** Bỏ giữ hàng của đơn (huỷ đơn). */
export async function release(_orderId: string): Promise<void> {
  throw notImplemented('release', '#16');
}

/** Lập và ghi sổ phiếu xuất theo đơn, tiêu giữ chỗ; `unitCost` là giá vốn lúc xuất (K2). */
export async function issueForOrder(
  _orderId: string,
): Promise<{ issueId: string; number: string; lines: { variantId: string; quantity: number; unitCost: Decimal }[] }> {
  throw notImplemented('issueForOrder', '#16');
}

/** Phiếu nhập hoàn đã ghi sổ cho đơn giao thất bại (K8). */
export async function receiveReturn(
  _orderId: string,
  _lines: readonly StockLine[],
): Promise<{ receiptId: string; number: string }> {
  throw notImplemented('receiveReturn', '#16');
}
