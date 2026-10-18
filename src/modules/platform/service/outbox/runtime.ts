import { setTimeout as sleep } from 'node:timers/promises';
import { env } from '../../../../shared/config/env.ts';
import { logger } from '../../../../shared/logger.ts';

/** Thông số của relay và consumer. Mặc định lấy từ biến môi trường và lựa chọn trong plan #38 (A5, A6). */
export interface OutboxOptions {
  readonly brokers: readonly string[];
  readonly clientId: string;
  readonly topicPrefix: string;
  /** Nghỉ giữa hai lượt relay khi outbox hết dòng chưa gửi. */
  readonly pollMs: number;
  readonly batchSize: number;
  /** Producer bỏ cuộc sau chừng này (librdkafka mặc định 300 s): relay rollback, lượt sau gửi lại. */
  readonly messageTimeoutMs: number;
  /** Lịch chờ trước mỗi lần thử lại handler lỗi (V39: 1 s, 5 s, 30 s); hết lịch thì sang DLQ. */
  readonly retryDelaysMs: readonly number[];
  readonly cleanupEveryMs: number;
}

export function outboxOptions(overrides: Partial<OutboxOptions> = {}): OutboxOptions {
  return {
    brokers: env.KAFKA_BROKERS.split(',').map((b) => b.trim()),
    clientId: env.KAFKA_CLIENT_ID,
    topicPrefix: env.KAFKA_TOPIC_PREFIX,
    pollMs: 500,
    batchSize: 500,
    messageTimeoutMs: 30_000,
    retryDelaysMs: [1_000, 5_000, 30_000],
    cleanupEveryMs: 60 * 60 * 1_000,
    ...overrides,
  };
}

export const outboxLogger = logger.child({ component: 'outbox' });

/**
 * Gọi `fn` tới khi thành công hoặc `signal` huỷ, chờ lùi 1 s → 30 s giữa các lần lỗi.
 * Dùng khi nối Kafka: broker chết thì `connect()` có thể treo vài phút, worker không được chờ theo.
 */
export async function retryUntilAborted<T>(label: string, signal: AbortSignal, fn: () => Promise<T>): Promise<T | undefined> {
  for (let failures = 0; !signal.aborted; failures++) {
    try {
      return await fn();
    } catch (err) {
      if (signal.aborted) return undefined;
      const delay = Math.min(1_000 * 2 ** failures, 30_000);
      outboxLogger.warn({ err, delay }, `${label} lỗi, thử lại`);
      await sleep(delay, undefined, { signal }).catch(() => undefined);
    }
  }
  return undefined;
}
