// Lượt đồng bộ do người bấm (Documents/21 §18 "Kết quả lượt đồng bộ"). Chạy trong `withCompany` của bên gọi.
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { listingSyncRuns, type SyncRunErrorRow } from './schema.ts';

export type SyncRunRow = typeof listingSyncRuns.$inferSelect;

/** Trần số dòng lỗi giữ trên một lượt; số đủ ở `failed`. */
export const SYNC_RUN_ERRORS_MAX = 200;

/** Số lần thử chèn lượt mới khi lượt `queued` vướng unique vừa bị nhận hay vừa thành `failed` trước khi đọc lại. */
export const OPEN_RUN_ATTEMPTS = 5;

/**
 * Lượt `queued` của gian hàng, hoặc tạo mới (unique một phần `listing_sync_runs_one_queued_uq` chặn hai lượt chờ khi đua).
 * Lượt `queued` xếp trước `staleBefore` (việc mất, worker chết) thành `failed` `run_stale` rồi tạo lượt mới, không dùng lại
 * lượt mà GET đã đọc ra `failed`. Chèn vướng unique mà đọc lại không thấy lượt chờ (việc đồng bộ vừa nhận nó sang
 * `running` giữa hai câu) thì chèn lại. Thử đủ `OPEN_RUN_ATTEMPTS` lần vẫn không được thì trả `undefined`, bên gọi báo lỗi.
 */
export async function queuedRunOrInsert(
  companyId: string,
  shopId: string,
  requestedBy: string,
  stale: { before: Date; error: { code: string; message: string } },
): Promise<SyncRunRow | undefined> {
  for (let attempt = 0; attempt < OPEN_RUN_ATTEMPTS; attempt++) {
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
    if (!queued) continue;
    if (queued.requestedAt.getTime() >= stale.before.getTime()) return queued;
    const now = new Date();
    await getDb()
      .update(listingSyncRuns)
      .set({ status: 'failed', startedAt: now, finishedAt: now, error: stale.error })
      .where(and(eq(listingSyncRuns.id, queued.id), eq(listingSyncRuns.status, 'queued')));
  }
  return undefined;
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

/**
 * Một lô đã ghi xong: cộng số, nối dòng lỗi (giữ tối đa `SYNC_RUN_ERRORS_MAX`). `skipped`: dòng đã tính vào `total` nhưng
 * không ghi được vì lệch `version` (lượt sau đẩy số mới), trừ khỏi `total` để `processed` vẫn tới `total`.
 */
export async function addRunBatch(
  ids: readonly string[],
  batch: { succeeded: number; failed: number; skipped?: number; errors: readonly SyncRunErrorRow[] },
): Promise<void> {
  const skipped = batch.skipped ?? 0;
  if (!ids.length || batch.succeeded + batch.failed + skipped === 0) return;
  const errors = JSON.stringify(batch.errors);
  await getDb()
    .update(listingSyncRuns)
    .set({
      processed: sql`${listingSyncRuns.processed} + ${batch.succeeded + batch.failed}`,
      succeeded: sql`${listingSyncRuns.succeeded} + ${batch.succeeded}`,
      failed: sql`${listingSyncRuns.failed} + ${batch.failed}`,
      total: sql`${listingSyncRuns.total} - ${skipped}`,
      errors: sql`(select coalesce(jsonb_agg(e), '[]'::jsonb) from (
        select e from jsonb_array_elements(${listingSyncRuns.errors} || ${errors}::jsonb) e limit ${SYNC_RUN_ERRORS_MAX}
      ) x)`,
    })
    .where(inArray(listingSyncRuns.id, [...ids]));
}

/**
 * Kết thúc các lượt (chỉ lượt còn `running`). Xong mà chưa có `total` (không có listing nào phải đẩy, `pushDue` không đặt)
 * thì `total = 0`: `null` chỉ dùng khi đang đọc trạng thái trên sàn (21 §18 "Kết quả lượt đồng bộ").
 */
export async function finishRuns(ids: readonly string[], at: Date, error: { code: string; message: string } | null = null): Promise<void> {
  if (!ids.length) return;
  await getDb()
    .update(listingSyncRuns)
    .set({ status: error ? 'failed' : 'done', finishedAt: at, error, ...(!error && { total: sql`coalesce(${listingSyncRuns.total}, 0)` }) })
    .where(and(inArray(listingSyncRuns.id, [...ids]), eq(listingSyncRuns.status, 'running')));
}

/** Gian hàng không chạy đồng bộ được nữa (ngắt, mất token): lượt còn `queued` thành `failed`. */
export async function failQueuedRuns(shopId: string, at: Date, error: { code: string; message: string }): Promise<void> {
  await getDb()
    .update(listingSyncRuns)
    .set({ status: 'failed', startedAt: at, finishedAt: at, error })
    .where(and(eq(listingSyncRuns.shopId, shopId), eq(listingSyncRuns.status, 'queued')));
}
