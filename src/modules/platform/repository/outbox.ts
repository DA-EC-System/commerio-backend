import { and, asc, inArray, isNull, lt, sql } from 'drizzle-orm';
import { getDb } from '../../../shared/db/client.ts';
import { outboxMessages, processedEvents } from './schema.ts';

// Truy vấn outbox (#38). Ghi thêm chạy dưới role ứng dụng (chỉ INSERT, không RETURNING); đọc, đánh dấu, dọn chạy
// bằng role chủ bảng trong worker (Documents/21 D5, V40).

export type OutboxRow = typeof outboxMessages.$inferSelect;

export async function insertOutboxMessage(row: typeof outboxMessages.$inferInsert): Promise<void> {
  await getDb().insert(outboxMessages).values(row);
}

/** Điều kiện "topic thuộc tiền tố": so chuỗi đầu, không dùng LIKE vì `_` trong tiền tố là ký tự đại diện. */
const ofPrefix = (prefix: string) =>
  sql`left(${outboxMessages.topic}, ${prefix.length + 1}) = ${`${prefix}.`}`;

/** Một relay mỗi lúc cho mỗi tiền tố (D6). Khoá tự nhả khi giao dịch kết thúc. */
export async function tryLockRelay(prefix: string): Promise<boolean> {
  const result = await getDb().execute<{ locked: boolean }>(
    sql`select pg_try_advisory_xact_lock(hashtextextended(${`platform.outbox_relay:${prefix}`}, 0)) as locked`,
  );
  return result.rows[0]!.locked;
}

export async function findPendingBatch(prefix: string, limit: number): Promise<OutboxRow[]> {
  return getDb()
    .select()
    .from(outboxMessages)
    .where(and(isNull(outboxMessages.publishedAt), ofPrefix(prefix)))
    .orderBy(asc(outboxMessages.id))
    .limit(limit);
}

export async function markPublished(ids: readonly number[]): Promise<void> {
  await getDb().update(outboxMessages).set({ publishedAt: new Date() }).where(inArray(outboxMessages.id, [...ids]));
}

export async function deletePublishedBefore(prefix: string, before: Date): Promise<void> {
  await getDb()
    .delete(outboxMessages)
    .where(and(lt(outboxMessages.publishedAt, before), ofPrefix(prefix)));
}

export async function deleteProcessedBefore(before: Date): Promise<void> {
  await getDb().delete(processedEvents).where(lt(processedEvents.processedAt, before));
}

/** Ghi "đã xử lý"; `false` nếu consumer này đã xử lý sự kiện đó rồi. */
export async function markProcessed(consumer: string, eventId: string): Promise<boolean> {
  const result = await getDb().insert(processedEvents).values({ consumer, eventId }).onConflictDoNothing();
  return (result.rowCount ?? 0) > 0;
}

export async function pendingStats(prefix: string): Promise<{ count: number; oldestAgeSeconds: number }> {
  const result = await getDb().execute<{ count: string; age: string | null }>(
    sql`select count(*) as count, extract(epoch from now() - min(${outboxMessages.createdAt})) as age
        from ${outboxMessages} where ${outboxMessages.publishedAt} is null and ${ofPrefix(prefix)}`,
  );
  const row = result.rows[0]!;
  return { count: Number(row.count), oldestAgeSeconds: Number(row.age ?? 0) };
}
