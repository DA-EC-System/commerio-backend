import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { paymentTransactions, webhookEvents } from './schema.ts';

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

