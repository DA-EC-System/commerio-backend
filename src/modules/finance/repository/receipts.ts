import { inArray } from 'drizzle-orm';
import { getDb } from '../../../shared/db/client.ts';
import { receipts, unmatchedReceipts } from './schema.ts';

export type ReceiptRow = typeof receipts.$inferSelect;

export async function insertReceipt(values: typeof receipts.$inferInsert): Promise<ReceiptRow> {
  const [row] = await getDb().insert(receipts).values(values).returning();
  return row!;
}

export async function insertUnmatchedReceipt(values: typeof unmatchedReceipts.$inferInsert): Promise<string> {
  const [row] = await getDb().insert(unmatchedReceipts).values(values).returning({ id: unmatchedReceipts.id });
  return row!.id;
}

/** Phiếu thu và khoản thu chưa khớp của các giao dịch cổng (RLS theo công ty đang mở). */
export async function findRefsOfTransactions(transactionIds: readonly string[]) {
  const ids = [...transactionIds];
  const [r, u] = await Promise.all([
    getDb()
      .select({ txnId: receipts.paymentTransactionId, id: receipts.id, number: receipts.number })
      .from(receipts)
      .where(inArray(receipts.paymentTransactionId, ids)),
    getDb()
      .select({ txnId: unmatchedReceipts.paymentTransactionId, id: unmatchedReceipts.id })
      .from(unmatchedReceipts)
      .where(inArray(unmatchedReceipts.paymentTransactionId, ids)),
  ]);
  return { receipts: r, unmatched: u };
}
