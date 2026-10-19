// Hàm cho fulfillment (#25) gọi (plan chuẩn bị 4.5; Documents/21 §11, T17): gọi trong `withCompany` của bên gọi.
import { Decimal } from 'decimal.js';
import { requireCompanyId } from '../../../shared/db/client.ts';
import { isUuid } from '../../../shared/uuid.ts';
import { AppError } from '../../../shared/errors/app-error.ts';
import { publishEvent } from '../../platform/index.ts';
import { getOrderLines, getOrdersForFinance } from '../../sales/index.ts';
import { findPostedInvoiceOfOrder, type InvoiceRow, insertInvoice, lockInvoiceOfOrder } from '../repository/invoices.ts';
import { collectCod } from './cod.ts';
import { nextDocNumber } from './doc-numbers.ts';

const notFound = () => new AppError(404, 'not_found', 'Không tìm thấy đơn hàng');

/**
 * Hoá đơn bán của đơn, trong cùng giao dịch ghi sổ phiếu xuất (QT-39, T17). Dòng hoá đơn là dòng hàng của đơn; `total` là
 * tổng đơn, gồm phí vận chuyển (plan #27 A20). Đơn đã có hoá đơn `posted` chưa đảo thì trả hoá đơn đó, `created: false`.
 * Đơn không thấy → 404; đơn không có dòng hàng → 409 `order_has_no_lines`.
 */
export async function issueInvoiceForOrder(
  orderId: string,
): Promise<{ invoiceId: string; number: string; total: Decimal; created: boolean }> {
  const companyId = requireCompanyId('issueInvoiceForOrder');
  if (!isUuid(orderId)) throw notFound();
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
  // T17: dòng hoá đơn = dòng đơn; đơn rỗng mà vẫn lập thì ghi doanh thu không có hàng (#63 B16).
  if (lines.length === 0) throw new AppError(409, 'order_has_no_lines', 'Đơn không có dòng hàng, không lập được hoá đơn');
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

/**
 * Thu COD một đơn đã giao trong giao dịch của bên gọi (cùng đường `POST /finance/cod-confirmations`, T18): đơn
 * `cod_collected`, phiếu thu `cod` = tổng đơn. `amount` khác tổng đơn → 422 (QT-38 không thu một phần). Bên gọi hiện
 * không có: kế toán xác nhận COD qua API; #25 không gọi hàm này.
 */
export async function recordCodCollected(orderId: string, amount: Decimal): Promise<{ receiptId: string; number: string }> {
  const companyId = requireCompanyId('recordCodCollected');
  const order = (await getOrdersForFinance([orderId])).get(orderId);
  if (!order) throw notFound();
  if (!order.total.equals(amount)) {
    throw new AppError(422, 'amount_mismatch', 'Số tiền COD khác tổng đơn', { errors: { amount: 'Phải bằng tổng đơn' } });
  }
  const { receipt } = (await collectCod(companyId, null, [orderId]))[0]!;
  return { receiptId: receipt.id, number: receipt.number };
}
