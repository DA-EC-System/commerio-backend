// Ghi phiếu thu, khoản thu chưa khớp (webhook cổng, đối soát bảng kê #30). Phần đọc cho route tiền cũ đã gỡ ở #235.
import { getDb } from '../../../../shared/db/client.ts';
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
