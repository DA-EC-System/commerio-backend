// Bảng kê và dòng đối soát tiền sàn (#30). Chạy trong `withCompany` của bên gọi (RLS theo công ty).
import { and, desc, eq, getTableColumns, gt, gte, isNull, lt, ne, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { receipts, settlementLines, settlementStatements } from './schema.ts';

type StatementRow = typeof settlementStatements.$inferSelect;
type LineInsert = typeof settlementLines.$inferInsert;

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

// --- Đọc cho API (§12.6) ---

export interface StatementFilter {
  id?: string;
  shopId?: string;
  paymentStatus?: string;
  from?: Date;
  to?: Date;
}

function statementWhere(f: StatementFilter) {
  return and(
    f.id ? eq(settlementStatements.id, f.id) : undefined,
    f.shopId ? eq(settlementStatements.shopId, f.shopId) : undefined,
    f.paymentStatus ? eq(settlementStatements.paymentStatus, f.paymentStatus) : undefined,
    f.from ? gte(settlementStatements.statementTime, f.from) : undefined,
    f.to ? lt(settlementStatements.statementTime, f.to) : undefined,
  );
}

const countOf = (status: string) => sql<number>`(count(*) filter (where ${settlementLines.matchStatus} = ${status}))::int`;

/** Bảng kê kèm số dòng theo trạng thái và tổng phiếu thu đã sinh, mới nhất trước. */
export async function listStatements(f: StatementFilter, limit: number, offset: number) {
  const where = statementWhere(f);
  const [rows, [count]] = await Promise.all([
    getDb()
      .select({
        ...getTableColumns(settlementStatements),
        lineCount: sql<number>`count(${settlementLines.id})::int`,
        matchedCount: countOf('matched'),
        discrepancyCount: countOf('discrepancy'),
        refundTaggedCount: countOf('refund_tagged'),
        receiptTotal: sql<string>`coalesce(sum(${receipts.amount}) filter (where ${receipts.status} = 'posted'), 0)::text`,
      })
      .from(settlementStatements)
      .leftJoin(settlementLines, eq(settlementLines.statementId, settlementStatements.id))
      .leftJoin(receipts, eq(receipts.settlementLineId, settlementLines.id))
      .where(where)
      .groupBy(settlementStatements.id)
      .orderBy(desc(settlementStatements.statementTime), settlementStatements.id)
      .limit(limit)
      .offset(offset),
    getDb().select({ total: sql<number>`count(*)::int` }).from(settlementStatements).where(where),
  ]);
  return { rows, total: count!.total };
}

export interface LineFilter extends Omit<StatementFilter, 'id' | 'paymentStatus'> {
  statementId?: string;
  matchStatus?: 'matched' | 'discrepancy' | 'refund_tagged';
  orderId?: string;
}

/** Dòng đối soát kèm trạng thái trả tiền của bảng kê và phiếu thu đã sinh. */
export async function listLines(f: LineFilter, limit: number, offset: number) {
  // Có bảng kê thì không lọc theo thời điểm (§12.6).
  const byTime = f.statementId ? {} : { from: f.from, to: f.to };
  const where = and(
    statementWhere({ shopId: f.shopId, ...byTime }),
    f.statementId ? eq(settlementLines.statementId, f.statementId) : undefined,
    f.matchStatus ? eq(settlementLines.matchStatus, f.matchStatus) : undefined,
    f.orderId ? eq(settlementLines.orderId, f.orderId) : undefined,
  );
  const [rows, [count]] = await Promise.all([
    getDb()
      .select({
        line: settlementLines,
        paymentStatus: settlementStatements.paymentStatus,
        receiptId: receipts.id,
        receiptNumber: receipts.number,
      })
      .from(settlementLines)
      .innerJoin(settlementStatements, eq(settlementStatements.id, settlementLines.statementId))
      .leftJoin(receipts, eq(receipts.settlementLineId, settlementLines.id))
      .where(where)
      .orderBy(desc(settlementStatements.statementTime), settlementLines.createdAt, settlementLines.id)
      .limit(limit)
      .offset(offset),
    getDb()
      .select({ total: sql<number>`count(*)::int` })
      .from(settlementLines)
      .innerJoin(settlementStatements, eq(settlementStatements.id, settlementLines.statementId))
      .where(where),
  ]);
  return { rows, total: count!.total };
}
