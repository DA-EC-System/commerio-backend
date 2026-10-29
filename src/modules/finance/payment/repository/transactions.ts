import { and, desc, eq, gte, inArray, lt, type SQL, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { paymentLinks, paymentTransactions, webhookEvents } from './schema.ts';

export type TransactionRow = typeof paymentTransactions.$inferSelect;

/** Ghi webhook đã kiểm chữ ký; trùng `event_key` (cổng gửi lại) → `false`, không ghi (§12.4 bước 4). */
export async function insertWebhookEventIfNew(values: typeof webhookEvents.$inferInsert): Promise<boolean> {
  const rows = await getDb()
    .insert(webhookEvents)
    .values({ ...values, processedAt: sql`now()` })
    .onConflictDoNothing()
    .returning({ id: webhookEvents.id });
  return rows.length > 0;
}

/** Ghi giao dịch cổng; trùng `(gateway, gateway_txn_id)` toàn hệ thống → `undefined`, không ghi. */
export async function insertTransactionIfNew(values: typeof paymentTransactions.$inferInsert): Promise<string | undefined> {
  const [row] = await getDb()
    .insert(paymentTransactions)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: paymentTransactions.id });
  return row?.id;
}

export async function findTransactionId(gateway: TransactionRow['gateway'], gatewayTxnId: string): Promise<string | undefined> {
  const [row] = await getDb()
    .select({ id: paymentTransactions.id })
    .from(paymentTransactions)
    .where(and(eq(paymentTransactions.gateway, gateway), eq(paymentTransactions.gatewayTxnId, gatewayTxnId)));
  return row?.id;
}

const withCode = { transaction: paymentTransactions, paymentCode: paymentLinks.paymentCode };

export interface TransactionFilter {
  gateway?: TransactionRow['gateway'];
  status?: TransactionRow['status'];
  from?: Date;
  to?: Date;
}

function whereOf(f: TransactionFilter): SQL | undefined {
  return and(
    f.gateway ? eq(paymentTransactions.gateway, f.gateway) : undefined,
    f.status ? eq(paymentTransactions.status, f.status) : undefined,
    f.from ? gte(paymentTransactions.occurredAt, f.from) : undefined,
    f.to ? lt(paymentTransactions.occurredAt, f.to) : undefined,
  );
}

/** Giao dịch của công ty (RLS) kèm mã thanh toán (join cùng schema), mới nhất trước; không `limit` thì lấy hết. */
export async function findTransactions(f: TransactionFilter, page?: { limit: number; offset: number }) {
  const query = getDb()
    .select(withCode)
    .from(paymentTransactions)
    .leftJoin(paymentLinks, eq(paymentLinks.id, paymentTransactions.paymentLinkId))
    .where(whereOf(f))
    .orderBy(desc(paymentTransactions.occurredAt), desc(paymentTransactions.id));
  return page ? query.limit(page.limit).offset(page.offset) : query;
}

export async function countTransactions(f: TransactionFilter): Promise<number> {
  const [row] = await getDb().select({ n: sql<number>`count(*)::int` }).from(paymentTransactions).where(whereOf(f));
  return row!.n;
}

export async function findTransactionsByIds(ids: readonly string[]) {
  if (ids.length === 0) return [];
  return getDb()
    .select(withCode)
    .from(paymentTransactions)
    .leftJoin(paymentLinks, eq(paymentLinks.id, paymentTransactions.paymentLinkId))
    .where(inArray(paymentTransactions.id, [...ids]));
}
