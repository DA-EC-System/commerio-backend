// Phiếu nhập, phiếu xuất và bộ đếm số phiếu. Chạy trong `withCompany` của bên gọi.
import { and, eq, ne, sql } from 'drizzle-orm';
import { getDb } from '../../../shared/db/client.ts';
import { companyOfTransaction } from './levels.ts';
import { docCounters, stockIssueLines, stockIssues, stockReceiptLines, stockReceipts } from './schema.ts';

/** Số kế tiếp của loại phiếu trong công ty (plan #16 A5, đo E1): upsert khoá đúng một dòng, không trùng khi song song. */
export async function nextDocSeq(docType: 'receipt' | 'issue'): Promise<number> {
  const [row] = await getDb()
    .insert(docCounters)
    .values({ companyId: companyOfTransaction(), docType, nextNumber: 2 })
    .onConflictDoUpdate({
      target: [docCounters.companyId, docCounters.docType, docCounters.period],
      set: { nextNumber: sql`${docCounters.nextNumber} + 1` },
    })
    .returning({ n: sql<number>`${docCounters.nextNumber} - 1` });
  return Number(row!.n);
}

/** Phiếu xuất chưa huỷ của đơn (mỗi đơn tối đa một, 19-D35). */
export async function findOrderIssue(orderId: string) {
  const [row] = await getDb()
    .select({ id: stockIssues.id, number: stockIssues.number, status: stockIssues.status })
    .from(stockIssues)
    .where(and(eq(stockIssues.orderId, orderId), ne(stockIssues.status, 'cancelled')));
  return row ?? null;
}

/** Chèn phiếu xuất theo đơn đã ghi sổ; đơn đã có phiếu chưa huỷ thì không chèn, trả `null` (gọi đồng thời an toàn). */
export async function insertOrderIssue(input: { orderId: string; number: string; actorId: string | null }) {
  const [row] = await getDb()
    .insert(stockIssues)
    .values({
      companyId: companyOfTransaction(),
      number: input.number,
      kind: 'order',
      orderId: input.orderId,
      status: 'done',
      createdBy: input.actorId,
      postedBy: input.actorId,
      postedAt: new Date(),
    })
    .onConflictDoNothing({ target: stockIssues.orderId, where: sql`status <> 'cancelled'` })
    .returning({ id: stockIssues.id });
  return row?.id ?? null;
}

export async function issueLines(issueId: string) {
  return getDb()
    .select({ id: stockIssueLines.id, variantId: stockIssueLines.variantId, quantity: stockIssueLines.quantity, unitCost: stockIssueLines.unitCost })
    .from(stockIssueLines)
    .where(eq(stockIssueLines.issueId, issueId));
}

export async function insertIssueLines(issueId: string, lines: readonly { variantId: string; quantity: number }[]) {
  const companyId = companyOfTransaction();
  return getDb()
    .insert(stockIssueLines)
    .values(lines.map((l) => ({ companyId, issueId, variantId: l.variantId, quantity: l.quantity })))
    .returning({ id: stockIssueLines.id, variantId: stockIssueLines.variantId, quantity: stockIssueLines.quantity });
}

/** Phiếu nhập hoàn chưa huỷ của đơn (mỗi đơn tối đa một, 19-D35). */
export async function findOrderReturn(orderId: string) {
  const [row] = await getDb()
    .select({ id: stockReceipts.id, number: stockReceipts.number })
    .from(stockReceipts)
    .where(and(eq(stockReceipts.orderId, orderId), eq(stockReceipts.kind, 'delivery_return'), ne(stockReceipts.status, 'cancelled')));
  return row ?? null;
}

/** Chèn phiếu nhập hoàn đã ghi sổ; đơn đã có phiếu chưa huỷ thì `null`. */
export async function insertReturnReceipt(input: { orderId: string; number: string; note: string | null; actorId: string | null }) {
  const [row] = await getDb()
    .insert(stockReceipts)
    .values({
      companyId: companyOfTransaction(),
      number: input.number,
      kind: 'delivery_return',
      orderId: input.orderId,
      status: 'done',
      note: input.note,
      createdBy: input.actorId,
      postedBy: input.actorId,
      postedAt: new Date(),
    })
    .onConflictDoNothing({ target: stockReceipts.orderId, where: sql`kind = 'delivery_return' and status <> 'cancelled'` })
    .returning({ id: stockReceipts.id });
  return row?.id ?? null;
}

export async function insertReceiptLines(receiptId: string, lines: readonly { variantId: string; quantity: number }[]) {
  const companyId = companyOfTransaction();
  return getDb()
    .insert(stockReceiptLines)
    .values(lines.map((l) => ({ companyId, receiptId, variantId: l.variantId, quantity: l.quantity })))
    .returning({ id: stockReceiptLines.id, variantId: stockReceiptLines.variantId, quantity: stockReceiptLines.quantity });
}
