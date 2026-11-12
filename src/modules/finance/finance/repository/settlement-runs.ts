import { and, count, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { currentCompanyId, getDb } from '../../../../shared/db/client.ts';
import { settlementBatches } from './schema.ts';

export type SettlementRunRow = typeof settlementBatches.$inferSelect;

/** Mỗi gian hàng mỗi lúc một lần đối soát: khoá tới hết giao dịch. */
export async function lockShopRuns(shopId: string): Promise<void> {
  const key = `finance.settlement-run:${currentCompanyId()}:${shopId}`;
  await getDb().execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

export async function findRun(id: string): Promise<SettlementRunRow | undefined> {
  const [row] = await getDb().select().from(settlementBatches).where(eq(settlementBatches.id, id));
  return row;
}

export async function findRunningRun(shopId: string): Promise<SettlementRunRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(settlementBatches)
    .where(and(eq(settlementBatches.shopId, shopId), eq(settlementBatches.status, 'running')));
  return row;
}

/** Mốc kéo của gian hàng: cuối kỳ của lần `done` gần nhất (mốc chỉ tiến khi cả lô ghi xong). */
export async function lastDoneTo(shopId: string): Promise<Date | null> {
  const [row] = await getDb()
    .select({ to: sql<Date | null>`max(${settlementBatches.periodTo})` })
    .from(settlementBatches)
    .where(and(eq(settlementBatches.shopId, shopId), eq(settlementBatches.status, 'done')));
  return row?.to ? new Date(row.to) : null;
}

export async function insertRun(values: typeof settlementBatches.$inferInsert): Promise<SettlementRunRow> {
  const [row] = await getDb().insert(settlementBatches).values(values).returning();
  return row!;
}

/** Kết thúc lần chạy đang `running` (lần khác đã kết thúc nó thì không đổi). */
export async function finishRun(
  id: string,
  values: Pick<SettlementRunRow, 'status'> & Partial<Pick<SettlementRunRow, 'lineCount' | 'duplicates' | 'walletDiff' | 'error'>>,
): Promise<SettlementRunRow | undefined> {
  const [row] = await getDb()
    .update(settlementBatches)
    .set({ ...values, version: sql`${settlementBatches.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(settlementBatches.id, id), eq(settlementBatches.status, 'running')))
    .returning();
  return row;
}

/** Mở lại lần `failed` để chạy tiếp (Admin chạy lại việc lỗi, #248). */
export async function reopenRun(id: string): Promise<SettlementRunRow | undefined> {
  const [row] = await getDb()
    .update(settlementBatches)
    .set({ status: 'running', error: null, version: sql`${settlementBatches.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(settlementBatches.id, id), eq(settlementBatches.status, 'failed')))
    .returning();
  return row;
}

/** Lần mới nhất của gian hàng. */
export async function latestRun(shopId: string): Promise<SettlementRunRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(settlementBatches)
    .where(eq(settlementBatches.shopId, shopId))
    .orderBy(desc(settlementBatches.createdAt), desc(settlementBatches.id))
    .limit(1);
  return row;
}

export async function listRuns(shopId: string | undefined, page: { limit: number; offset: number }): Promise<{ rows: SettlementRunRow[]; total: number }> {
  const where = shopId ? eq(settlementBatches.shopId, shopId) : undefined;
  const rows = await getDb()
    .select()
    .from(settlementBatches)
    .where(where)
    .orderBy(desc(settlementBatches.createdAt), desc(settlementBatches.id))
    .limit(page.limit)
    .offset(page.offset);
  const [total] = await getDb().select({ n: count() }).from(settlementBatches).where(where);
  return { rows, total: total?.n ?? 0 };
}

/**
 * `wallet_diff` của lần `done` gần nhất có số của từng gian hàng (#251, Documents/21 §21.3): gần nhất theo cuối kỳ
 * (`period_to`) giảm dần, bằng nhau thì theo `created_at`; lần `done` sàn không trả kỳ quyết toán (null) bỏ qua.
 */
export async function latestWalletDiffs(shopIds: readonly string[]): Promise<Map<string, string>> {
  if (!shopIds.length) return new Map();
  const rows = await getDb()
    .selectDistinctOn([settlementBatches.shopId], { shopId: settlementBatches.shopId, walletDiff: settlementBatches.walletDiff })
    .from(settlementBatches)
    .where(and(inArray(settlementBatches.shopId, [...shopIds]), eq(settlementBatches.status, 'done'), isNotNull(settlementBatches.walletDiff)))
    .orderBy(settlementBatches.shopId, desc(settlementBatches.periodTo), desc(settlementBatches.createdAt));
  return new Map(rows.map((r) => [r.shopId, r.walletDiff!]));
}
