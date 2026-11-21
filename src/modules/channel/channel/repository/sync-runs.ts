// Lượt đồng bộ do người bấm (Documents/21 §18 "Kết quả lượt đồng bộ"). Chạy trong `withCompany` của bên gọi.
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { listingSyncRuns, type SyncRunErrorRow } from './schema.ts';

export type SyncRunRow = typeof listingSyncRuns.$inferSelect;

/** Trần số dòng lỗi giữ trên một lượt; số đủ ở `failed`. */
export const SYNC_RUN_ERRORS_MAX = 200;

/** Lượt `queued` của gian hàng, hoặc tạo mới (unique một phần `listing_sync_runs_one_queued_uq` chặn hai lượt chờ khi đua). */
export async function queuedRunOrInsert(companyId: string, shopId: string, requestedBy: string): Promise<SyncRunRow> {
  const [created] = await getDb()
    .insert(listingSyncRuns)
    .values({ companyId, shopId, requestedBy })
    .onConflictDoNothing({ target: listingSyncRuns.shopId, where: sql`${listingSyncRuns.status} = 'queued'` })
    .returning();
  if (created) return created;
  const [queued] = await getDb()
    .select()
    .from(listingSyncRuns)
    .where(and(eq(listingSyncRuns.shopId, shopId), eq(listingSyncRuns.status, 'queued')));
  return queued!;
}

export async function findSyncRun(shopId: string, id: string): Promise<SyncRunRow | undefined> {
  const [row] = await getDb().select().from(listingSyncRuns).where(and(eq(listingSyncRuns.id, id), eq(listingSyncRuns.shopId, shopId)));
  return row;
}

export async function latestSyncRun(shopId: string): Promise<SyncRunRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(listingSyncRuns)
    .where(eq(listingSyncRuns.shopId, shopId))
    .orderBy(desc(listingSyncRuns.requestedAt), desc(listingSyncRuns.id))
    .limit(1);
  return row;
}

/** Việc đồng bộ bắt đầu: nhận mọi lượt `queued` của gian hàng sang `running`. Trả id các lượt đã nhận. */
export async function claimQueuedRuns(shopId: string, at: Date): Promise<string[]> {
  const rows = await getDb()
    .update(listingSyncRuns)
    .set({ status: 'running', startedAt: at })
    .where(and(eq(listingSyncRuns.shopId, shopId), eq(listingSyncRuns.status, 'queued')))
    .returning({ id: listingSyncRuns.id });
  return rows.map((r) => r.id);
}

/** Đã biết số listing phải đẩy. */
export async function setRunTotal(ids: readonly string[], total: number): Promise<void> {
  if (!ids.length) return;
  await getDb().update(listingSyncRuns).set({ total }).where(inArray(listingSyncRuns.id, [...ids]));
}

/** Một lô đã ghi xong: cộng số, nối dòng lỗi (giữ tối đa `SYNC_RUN_ERRORS_MAX`). */
export async function addRunBatch(ids: readonly string[], batch: { succeeded: number; failed: number; errors: readonly SyncRunErrorRow[] }): Promise<void> {
  if (!ids.length || batch.succeeded + batch.failed === 0) return;
  const errors = JSON.stringify(batch.errors);
  await getDb()
    .update(listingSyncRuns)
    .set({
      processed: sql`${listingSyncRuns.processed} + ${batch.succeeded + batch.failed}`,
      succeeded: sql`${listingSyncRuns.succeeded} + ${batch.succeeded}`,
      failed: sql`${listingSyncRuns.failed} + ${batch.failed}`,
      errors: sql`(select coalesce(jsonb_agg(e), '[]'::jsonb) from (
        select e from jsonb_array_elements(${listingSyncRuns.errors} || ${errors}::jsonb) e limit ${SYNC_RUN_ERRORS_MAX}
      ) x)`,
    })
    .where(inArray(listingSyncRuns.id, [...ids]));
}

/** Kết thúc các lượt (chỉ lượt còn `running`). */
export async function finishRuns(ids: readonly string[], at: Date, error: { code: string; message: string } | null = null): Promise<void> {
  if (!ids.length) return;
  await getDb()
    .update(listingSyncRuns)
    .set({ status: error ? 'failed' : 'done', finishedAt: at, error })
    .where(and(inArray(listingSyncRuns.id, [...ids]), eq(listingSyncRuns.status, 'running')));
}

/** Gian hàng không chạy đồng bộ được nữa (ngắt, mất token): lượt còn `queued` thành `failed`. */
export async function failQueuedRuns(shopId: string, at: Date, error: { code: string; message: string }): Promise<void> {
  await getDb()
    .update(listingSyncRuns)
    .set({ status: 'failed', startedAt: at, finishedAt: at, error })
    .where(and(eq(listingSyncRuns.shopId, shopId), eq(listingSyncRuns.status, 'queued')));
}
