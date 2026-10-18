// Hàm cho fulfillment (#25) gọi (plan chuẩn bị 4.5; Documents/21 §11, T17): gọi trong `withCompany` của bên gọi.
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { currentCompanyId } from '../../../shared/db/client.ts';
import { AppError, notImplemented } from '../../../shared/errors/app-error.ts';
import { publishEvent } from '../../platform/index.ts';
import { getOrderLines, getOrdersForFinance } from '../../sales/index.ts';
import { findPostedInvoiceOfOrder, type InvoiceRow, insertInvoice, lockInvoiceOfOrder } from '../repository/invoices.ts';
import { nextDocNumber } from './doc-numbers.ts';

const notFound = () => new AppError(404, 'not_found', 'Không tìm thấy đơn hàng');

/**
 * Hoá đơn bán của đơn, trong cùng giao dịch ghi sổ phiếu xuất (QT-39, T17). Dòng hoá đơn là dòng hàng của đơn; `total` là
 * tổng đơn, gồm phí vận chuyển (plan #27 A20). Đơn đã có hoá đơn `posted` chưa đảo thì trả hoá đơn đó, `created: false`.
 * Đơn không thấy → 404.
 */
export async function issueInvoiceForOrder(
  orderId: string,
): Promise<{ invoiceId: string; number: string; total: Decimal; created: boolean }> {
  const companyId = currentCompanyId();
  if (!companyId) throw new Error('issueInvoiceForOrder phải gọi trong withCompany');
  if (!z.uuid().safeParse(orderId).success) throw notFound();
  const toResult = (inv: InvoiceRow, created: boolean) => ({
    invoiceId: inv.id,
    number: inv.number,
    total: new Decimal(inv.total),
    created,
  });

  await lockInvoiceOfOrder(orderId);
  const existing = await findPostedInvoiceOfOrder(orderId);
  if (existing) return toResult(existing, false);

  const order = (await getOrdersForFinance([orderId])).get(orderId);
  if (!order) throw notFound();
  const lines = await getOrderLines(orderId);
  const invoice = await insertInvoice(
    { companyId, number: await nextDocNumber('invoice'), orderId, total: order.total.toFixed(2) },
    lines.map((l) => ({
      orderLineId: l.id,
      variantId: l.variantId,
      quantity: l.quantity,
      unitPrice: l.unitPrice.toFixed(2),
    })),
  );
  await publishEvent({
    type: 'finance.invoice_posted',
    aggregateId: invoice.id,
    payload: {
      invoiceId: invoice.id,
      orderId,
      total: invoice.total,
      issuedAt: invoice.issuedAt.toISOString(),
      reversalOf: null,
    },
  });
  return toResult(invoice, true);
}

/** Phiếu thu COD của đơn đã giao (finance dùng cho `POST /finance/cod-confirmations`, PR3 của #27). */
export async function recordCodCollected(_orderId: string, _amount: Decimal): Promise<{ receiptId: string; number: string }> {
  throw notImplemented('recordCodCollected', '#27');
}
