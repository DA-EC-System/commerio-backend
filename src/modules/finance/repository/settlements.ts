// Bảng kê và dòng đối soát tiền sàn (#30). Chạy trong `withCompany` của bên gọi (RLS theo công ty).
import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { getDb } from '../../../shared/db/client.ts';
import { receipts, settlementLines, settlementStatements } from './schema.ts';

export type StatementRow = typeof settlementStatements.$inferSelect;
export type LineInsert = typeof settlementLines.$inferInsert;

/**
 * Khoá các lần nhận bảng kê của một công ty tới hết giao dịch (plan #30 A9): hai lần nhận song song chạy nối tiếp, cả
 * phần khớp lại toàn công ty và cấp số phiếu thu.
 */
export async function lockCompanySettlements(companyId: string): Promise<void> {
  await getDb().execute(sql`select pg_advisory_xact_lock(hashtextextended(${'finance.settlement:' + companyId}, 0))`);
}

export async function findStatementByExternalId(externalStatementId: string): Promise<StatementRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(settlementStatements)
    .where(eq(settlementStatements.externalStatementId, externalStatementId));
  return row;
}

export async function insertStatement(values: typeof settlementStatements.$inferInsert): Promise<string> {
  const [row] = await getDb().insert(settlementStatements).values(values).returning({ id: settlementStatements.id });
  return row!.id;
}

export async function updateStatement(
  id: string,
  values: Pick<StatementRow, 'statementTime' | 'settlementAmount' | 'paymentStatus'>,
): Promise<void> {
  await getDb()
    .update(settlementStatements)
    .set({ ...values, version: sql`${settlementStatements.version} + 1`, updatedAt: sql`now()` })
    .where(eq(settlementStatements.id, id));
}

/** Dòng đã có (trùng `external_transaction_id` của công ty, kể cả ở bảng kê khác) thì bỏ qua. */
export async function insertLinesIgnoringExisting(rows: readonly LineInsert[]): Promise<void> {
  if (rows.length === 0) return;
  await getDb()
    .insert(settlementLines)
    .values([...rows])
    .onConflictDoNothing({ target: [settlementLines.companyId, settlementLines.externalTransactionId] });
}

/** Dòng chưa thấy đơn của cả công ty, kèm gian hàng của bảng kê (cùng schema). */
export async function findOrderNotFoundLines() {
  return getDb()
    .select({ id: settlementLines.id, shopId: settlementStatements.shopId, raw: settlementLines.raw })
    .from(settlementLines)
    .innerJoin(settlementStatements, eq(settlementStatements.id, settlementLines.statementId))
    .where(eq(settlementLines.discrepancyReason, 'order_not_found'));
}

export async function updateLineMatch(
  id: string,
  values: Pick<LineInsert, 'orderId' | 'matchStatus' | 'discrepancyReason'>,
): Promise<void> {
  await getDb()
    .update(settlementLines)
    .set({ ...values, version: sql`${settlementLines.version} + 1`, updatedAt: sql`now()` })
    .where(eq(settlementLines.id, id));
}

/**
 * Dòng đủ điều kiện phiếu thu mà chưa có phiếu (A4, cùng luật `needsReceipt` của domain): bảng kê `PAID`, không lệch,
 * tiền về dương. Theo thứ tự tạo để số phiếu ổn định.
 */
export async function findLinesAwaitingReceipt() {
  return getDb()
    .select({ id: settlementLines.id, orderId: settlementLines.orderId, settlement: settlementLines.settlement })
    .from(settlementLines)
    .innerJoin(settlementStatements, eq(settlementStatements.id, settlementLines.statementId))
    .leftJoin(receipts, eq(receipts.settlementLineId, settlementLines.id))
    .where(
      and(
        eq(settlementStatements.paymentStatus, 'PAID'),
        ne(settlementLines.matchStatus, 'discrepancy'),
        gt(settlementLines.settlement, '0'),
        isNull(receipts.id),
      ),
    )
    .orderBy(settlementLines.createdAt, settlementLines.id);
}
