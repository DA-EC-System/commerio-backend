// Khung cho fulfillment (#25) gọi (plan chuẩn bị 4.5; Documents/21 §11): #27 viết thân ở file này,
// không sửa finance/index.ts. Gọi trong `withCompany` của bên gọi.
import type { Decimal } from 'decimal.js';
import { notImplemented } from '../../../shared/errors/app-error.ts';

/**
 * Hoá đơn bán của đơn, trong cùng giao dịch ghi sổ phiếu xuất (QT-39). Đơn đã có hoá đơn `posted` chưa đảo thì trả
 * hoá đơn đó, `created: false`.
 */
export async function issueInvoiceForOrder(
  _orderId: string,
): Promise<{ invoiceId: string; number: string; total: Decimal; created: boolean }> {
  throw notImplemented('issueInvoiceForOrder', '#27');
}

/** Phiếu thu COD của đơn đã giao. */
export async function recordCodCollected(_orderId: string, _amount: Decimal): Promise<{ receiptId: string; number: string }> {
  throw notImplemented('recordCodCollected', '#27');
}
