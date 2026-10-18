import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../../shared/db/client.ts';
import { salesInvoiceLines, salesInvoices } from './schema.ts';

export type InvoiceRow = typeof salesInvoices.$inferSelect;

/**
 * Khoá theo đơn tới hết giao dịch, trước khi kiểm "đã có hoá đơn": hai giao dịch lập hoá đơn cho cùng đơn chạy tuần
 * tự, bên sau thấy hoá đơn bên trước đã commit thay vì đụng unique một phần (23505).
 */
export async function lockInvoiceOfOrder(orderId: string): Promise<void> {
  await getDb().execute(sql`select pg_advisory_xact_lock(hashtext(${`finance.invoice:${orderId}`}))`);
}

/** Hoá đơn `posted` chưa bị đảo của đơn (tối đa một, unique một phần). */
export async function findPostedInvoiceOfOrder(orderId: string): Promise<InvoiceRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(salesInvoices)
    .where(and(eq(salesInvoices.orderId, orderId), eq(salesInvoices.status, 'posted'), isNull(salesInvoices.reversalOfId)));
  return row;
}

export async function insertInvoice(
  invoice: { companyId: string; number: string; orderId: string; total: string },
  lines: { orderLineId: string; variantId: string; quantity: number; unitPrice: string }[],
): Promise<InvoiceRow> {
  const [row] = await getDb().insert(salesInvoices).values(invoice).returning();
  await getDb()
    .insert(salesInvoiceLines)
    .values(lines.map((l) => ({ ...l, companyId: invoice.companyId, invoiceId: row!.id })));
  return row!;
}
