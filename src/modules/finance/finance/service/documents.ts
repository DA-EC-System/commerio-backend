// Hoá đơn, phiếu thu chỉ đọc (Documents/21 §12.5 bốn dòng đầu, §12.8 InvoiceSummary, Invoice, Receipt; plan #27 AC-23,
// AC-24, A15, A20). Chứng từ đảo (UC-PF-09) chưa có issue, chưa đường nào tạo ra: `reversalOf`, `reversedBy` luôn `null`.
import { withCompany } from '../../../../shared/db/client.ts';
import { getVariants } from '../../../product/index.ts';
import { getPaymentTransactions } from '../../payment/index.ts';
import { getOrderLines } from '../../../order/index.ts';
import { findInvoice, findInvoiceLines, findInvoices, type InvoiceFilter, type InvoiceRow } from '../repository/invoices.ts';
import { findReceipt, findReceipts, type ReceiptFilter, type ReceiptRow } from '../repository/receipts.ts';
import { isUuid, money, notFound, type Orders, orderRef, ordersOf, type Page, paginate } from './views.ts';

function invoiceSummary(inv: InvoiceRow, orders: Orders) {
  return {
    id: inv.id,
    number: inv.number,
    order: orderRef(orders, inv.orderId),
    status: inv.status,
    issuedAt: inv.issuedAt.toISOString(),
    total: money(inv.total),
    reversalOf: null,
    reversedBy: null,
    version: inv.version,
  };
}

export function listInvoices(companyId: string, q: InvoiceFilter & Page) {
  return withCompany(companyId, async () => {
    const rows = await findInvoices(q);
    const orders = await ordersOf(rows.map((r) => r.orderId));
    const { slice, ...pageInfo } = paginate(rows, q, (r) => [r.number, orders.get(r.orderId)?.code, orders.get(r.orderId)?.customerName]);
    return { items: slice.map((r) => invoiceSummary(r, orders)), ...pageInfo };
  });
}

export function getInvoice(companyId: string, id: string) {
  return withCompany(companyId, async () => {
    const inv = isUuid(id) ? await findInvoice(id) : undefined;
    if (!inv) throw notFound('hoá đơn');
    const [lines, orderLines, orders] = [await findInvoiceLines(inv.id), await getOrderLines(inv.orderId), await ordersOf([inv.orderId])];
    const variants = new Map((await getVariants(lines.map((l) => l.variantId))).map((v) => [v.id, v]));
    const lineOf = new Map(orderLines.map((l) => [l.id, l]));
    const items = lines.map((l) => {
      const ol = lineOf.get(l.orderLineId);
      const v = variants.get(l.variantId);
      return {
        variantId: l.variantId,
        // SKU, tên theo dòng đơn đã chép; nhãn thuộc tính theo catalog hiện tại (A15).
        sku: ol?.sku ?? v?.sku ?? '',
        productName: ol?.productName ?? v?.productName ?? '',
        attributesLabel: v?.attributes.map((a) => a.value).join(' / ') ?? '',
        quantity: l.quantity,
        unitPrice: money(l.unitPrice),
        lineTotal: money(l.unitPrice) * l.quantity,
      };
    });
    const linesTotal = items.reduce((s, l) => s + l.lineTotal, 0);
    return {
      ...invoiceSummary(inv, orders),
      lines: items,
      // Dòng hoá đơn chỉ là hàng; tổng gồm phí vận chuyển (A20).
      shippingFee: money(inv.total) - linesTotal,
      reversalReason: inv.reversalReason,
    };
  });
}

export async function receiptViews(rows: ReceiptRow[], orders: Orders) {
  const txns = await getPaymentTransactions(rows.flatMap((r) => (r.paymentTransactionId ? [r.paymentTransactionId] : [])));
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    source: r.source,
    order: orderRef(orders, r.orderId),
    amount: money(r.amount),
    status: r.status,
    postedAt: r.postedAt.toISOString(),
    gateway: r.paymentTransactionId ? (txns.get(r.paymentTransactionId)?.gateway ?? null) : null,
    paymentTransactionId: r.paymentTransactionId,
    settlementLineId: r.settlementLineId,
    unmatchedReceiptId: r.unmatchedReceiptId,
    reversalOf: null,
    reversedBy: null,
    reversalReason: r.reversalReason,
    version: r.version,
  }));
}

export function listReceipts(companyId: string, q: ReceiptFilter & Page) {
  return withCompany(companyId, async () => {
    if (q.orderId && !isUuid(q.orderId)) return { items: [], total: 0, page: q.page, pageSize: q.pageSize };
    const rows = await findReceipts(q);
    const orders = await ordersOf(rows.map((r) => r.orderId));
    const { slice, ...pageInfo } = paginate(rows, q, (r) => [r.number, orders.get(r.orderId ?? '')?.code]);
    return { items: await receiptViews(slice, orders), ...pageInfo };
  });
}

export function getReceipt(companyId: string, id: string) {
  return withCompany(companyId, async () => {
    const r = isUuid(id) ? await findReceipt(id) : undefined;
    if (!r) throw notFound('phiếu thu');
    return (await receiptViews([r], await ordersOf([r.orderId])))[0]!;
  });
}
