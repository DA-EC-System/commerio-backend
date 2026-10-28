import { and, desc, eq, gte, inArray, lt } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { receipts, unmatchedReceipts } from './schema.ts';

export type ReceiptRow = typeof receipts.$inferSelect;
export type UnmatchedRow = typeof unmatchedReceipts.$inferSelect;

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
  const r = await getDb()
    .select({ txnId: receipts.paymentTransactionId, id: receipts.id, number: receipts.number })
    .from(receipts)
    .where(inArray(receipts.paymentTransactionId, ids));
  const u = await getDb()
    .select({ txnId: unmatchedReceipts.paymentTransactionId, id: unmatchedReceipts.id })
    .from(unmatchedReceipts)
    .where(inArray(unmatchedReceipts.paymentTransactionId, ids));
  return { receipts: r, unmatched: u };
}

export interface ReceiptFilter {
  source?: ReceiptRow['source'];
  status?: ReceiptRow['status'];
  orderId?: string;
  orderIds?: readonly string[];
  from?: Date;
  to?: Date;
}

/** Phiếu thu của công ty (RLS) theo bộ lọc, mới nhất trước. */
export async function findReceipts(f: ReceiptFilter): Promise<ReceiptRow[]> {
  if (f.orderIds?.length === 0) return [];
  return getDb()
    .select()
    .from(receipts)
    .where(
      and(
        f.source ? eq(receipts.source, f.source) : undefined,
        f.status ? eq(receipts.status, f.status) : undefined,
        f.orderId ? eq(receipts.orderId, f.orderId) : undefined,
        f.orderIds ? inArray(receipts.orderId, [...f.orderIds]) : undefined,
        f.from ? gte(receipts.postedAt, f.from) : undefined,
        f.to ? lt(receipts.postedAt, f.to) : undefined,
      ),
    )
    .orderBy(desc(receipts.postedAt), desc(receipts.number));
}

export async function findReceipt(id: string): Promise<ReceiptRow | undefined> {
  const [row] = await getDb().select().from(receipts).where(eq(receipts.id, id));
  return row;
}

export interface UnmatchedFilter {
  status?: UnmatchedRow['status'];
  reason?: UnmatchedRow['reason'];
  from?: Date;
  to?: Date;
}

/** Khoản thu chưa khớp của công ty (RLS), mới nhận trước. */
export async function findUnmatchedList(f: UnmatchedFilter): Promise<UnmatchedRow[]> {
  return getDb()
    .select()
    .from(unmatchedReceipts)
    .where(
      and(
        f.status ? eq(unmatchedReceipts.status, f.status) : undefined,
        f.reason ? eq(unmatchedReceipts.reason, f.reason) : undefined,
        f.from ? gte(unmatchedReceipts.receivedAt, f.from) : undefined,
        f.to ? lt(unmatchedReceipts.receivedAt, f.to) : undefined,
      ),
    )
    .orderBy(desc(unmatchedReceipts.receivedAt), desc(unmatchedReceipts.id));
}

/** Phiếu thu gán từ các khoản thu chưa khớp. */
export async function findReceiptsOfUnmatched(ids: readonly string[]) {
  if (ids.length === 0) return [];
  return getDb()
    .select({ unmatchedId: receipts.unmatchedReceiptId, id: receipts.id, number: receipts.number })
    .from(receipts)
    .where(and(inArray(receipts.unmatchedReceiptId, [...ids]), eq(receipts.status, 'posted')));
}

/** Khoản thu chưa khớp; `lock` khoá dòng tới hết giao dịch (gán, hoàn tiền). */
export async function findUnmatched(id: string, lock?: 'update'): Promise<UnmatchedRow | undefined> {
  const query = getDb().select().from(unmatchedReceipts).where(eq(unmatchedReceipts.id, id));
  const [row] = await (lock ? query.for('update') : query);
  return row;
}
