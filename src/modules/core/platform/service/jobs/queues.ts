// Khai hàng việc, gửi việc, nhận việc (#102). Cách dùng ở CLAUDE.md của platform, mục "Việc nền".
import { sql } from 'drizzle-orm';
import { fromDrizzle, type QueuePolicy } from 'pg-boss';
import { z } from 'zod';
import { getDb } from '../../../../../shared/db/client.ts';
import { logger } from '../../../../../shared/logger.ts';
import { jobBoss } from './boss.ts';

/** Hàng chứa việc đã thử hết lượt mà vẫn lỗi. Admin xem và chạy lại; không có worker. */
export const DEAD_QUEUE = 'platform.dead';

/** Mọi việc mang công ty: API việc lỗi lọc theo đây, handler mở `withCompany` bằng nó. */
export const JobDataSchema = z.object({ companyId: z.uuid(), shopId: z.uuid().optional() });
export type JobData = z.infer<typeof JobDataSchema>;

export interface QueueOptions {
  /** `stately`: mỗi khoá chỉ một việc chờ và một việc đang chạy (đồng bộ theo gian hàng). Mặc định `standard`. */
  policy?: QueuePolicy;
  /** Số lần thử, kể cả lần đầu. Mặc định 5 (issue). */
  attempts?: number;
  /** Lần thử lại đầu sau bao nhiêu giây, các lần sau gấp đôi, trần 1 giờ. Mặc định 60. */
  retryDelaySeconds?: number;
  /** Chạy quá thời gian này thì coi như worker chết, việc được nhận lại. Mặc định 5 phút. */
  expireInSeconds?: number;
}

export interface Queue<T extends JobData> {
  readonly name: string;
  readonly schema: z.ZodType<T>;
  readonly options: QueueOptions;
}

/** Khai một hàng việc. Tên `<module>.<việc>`, vd `channel.listing_sync`. */
export function defineQueue<T extends JobData>(name: string, schema: z.ZodType<T>, options: QueueOptions = {}): Queue<T> {
  return { name, schema, options };
}

const ensured = new Map<string, Promise<void>>();

/** Tạo hàng nếu chưa có (một câu INSERT, không DDL). Lỗi thì lần sau thử lại. */
function ensureQueue(queue: Queue<JobData>): Promise<void> {
  let done = ensured.get(queue.name);
  if (!done) {
    done = (async () => {
      const boss = await jobBoss();
      await boss.createQueue(DEAD_QUEUE, { retentionSeconds: 30 * 86_400 });
      const { policy = 'standard', attempts = 5, retryDelaySeconds = 60, expireInSeconds = 300 } = queue.options;
      await boss.createQueue(queue.name, {
        policy,
        retryLimit: attempts - 1,
        retryDelay: retryDelaySeconds,
        retryBackoff: true,
        retryDelayMax: 3600,
        expireInSeconds,
        deadLetter: DEAD_QUEUE,
      });
    })();
    ensured.set(queue.name, done);
    done.catch(() => ensured.delete(queue.name));
  }
  return done;
}

/**
 * Gửi việc, đi chung giao dịch đang mở nếu có (giao dịch rollback thì không còn việc). `key` chống trùng
 * khi hàng là `stately`. Trả id việc, hoặc `null` khi đã có việc cùng khoá đang chờ.
 */
export async function sendJob<T extends JobData>(
  queue: Queue<T>,
  data: T,
  options: { key?: string; startAfter?: Date } = {},
): Promise<string | null> {
  const parsed = queue.schema.parse(data);
  await ensureQueue(queue);
  const boss = await jobBoss();
  return boss.send(queue.name, parsed, {
    singletonKey: options.key,
    startAfter: options.startAfter,
    db: fromDrizzle(getDb(), sql),
  });
}

/**
 * Nhận việc của một hàng (chỉ worker). Handler chạy ngoài giao dịch, tự mở `withCompany(data.companyId)`
 * cho phần ghi DB, để không giữ giao dịch trong lúc gọi sàn. Ném lỗi thì pg-boss thử lại theo hàng.
 */
export async function workQueue<T extends JobData>(
  queue: Queue<T>,
  handler: (data: T) => Promise<void>,
  options: { concurrency?: number } = {},
): Promise<void> {
  await ensureQueue(queue);
  const boss = await jobBoss();
  await boss.work<T>(queue.name, { localConcurrency: options.concurrency ?? 1 }, async ([job]) => {
    const data = queue.schema.parse(job!.data);
    try {
      await handler(data);
    } catch (err) {
      logger.warn({ queue: queue.name, jobId: job!.id, retryCount: job!.retryCount, reason: (err as Error).message }, 'việc nền lỗi');
      throw err;
    }
  });
}
