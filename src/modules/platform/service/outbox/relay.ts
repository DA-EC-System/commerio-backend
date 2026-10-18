import { setTimeout as sleep } from 'node:timers/promises';
import { inTransaction } from '../../../../shared/db/client.ts';
import type { EventEnvelope } from '../../../../shared/events/envelope.ts';
import {
  deleteProcessedBefore,
  deletePublishedBefore,
  findPendingBatch,
  markPublished,
  type OutboxRow,
  tryLockRelay,
} from '../../repository/outbox.ts';
import { createKafka, createProducer, ensureTopics, eventTopics, type Kafka, type Producer } from './kafka.ts';
import { type OutboxOptions, outboxLogger, retryUntilAborted } from './runtime.ts';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000; // V40: dòng đã gửi giữ 7 ngày

/** Xoá dòng outbox đã gửi và dấu "đã xử lý" quá 7 ngày. Chạy bằng role chủ bảng. */
export async function cleanupOutbox(prefix: string): Promise<void> {
  const before = new Date(Date.now() - RETENTION_MS);
  await deletePublishedBefore(prefix, before);
  await deleteProcessedBefore(before);
}

export function toKafkaMessage(row: OutboxRow) {
  const envelope: EventEnvelope = {
    eventId: row.eventId,
    type: row.type,
    companyId: row.companyId,
    aggregateId: row.key,
    occurredAt: row.createdAt.toISOString(),
    payload: row.payload,
  };
  return { key: row.key, value: JSON.stringify(envelope), headers: { type: row.type, eventId: row.eventId } };
}

export interface Relay {
  /** Một lượt: số dòng đã gửi, hoặc `'busy'` khi relay khác đang giữ khoá. Ném nếu Kafka không nhận. */
  tick(): Promise<number | 'busy'>;
  /** Chạy vòng lặp nền tới khi `stop()`. */
  start(): void;
  stop(): Promise<void>;
}

/**
 * Relay outbox → Kafka (Documents/21 D6): mỗi lượt giữ `pg_try_advisory_xact_lock`, lấy lô theo thứ tự id, gửi,
 * chờ broker xác nhận rồi mới đánh dấu đã gửi trong cùng giao dịch. Gửi hỏng thì rollback, lượt sau gửi lại cả lô.
 */
export function createRelay(options: OutboxOptions, kafka: Kafka = createKafka(options)): Relay {
  const controller = new AbortController();
  let producer: Producer | undefined;
  let loop: Promise<void> | undefined;

  async function connected(): Promise<Producer> {
    if (producer) return producer;
    const candidate = createProducer(kafka, options);
    try {
      await candidate.connect();
      await ensureTopics(kafka, eventTopics(options.topicPrefix));
    } catch (err) {
      await candidate.disconnect().catch(() => undefined);
      throw err;
    }
    producer = candidate;
    return producer;
  }

  async function tick(): Promise<number | 'busy'> {
    const p = await connected();
    return inTransaction(async () => {
      if (!(await tryLockRelay(options.topicPrefix))) return 'busy';
      const rows = await findPendingBatch(options.topicPrefix, options.batchSize);
      if (rows.length === 0) return 0;
      const byTopic = Map.groupBy(rows, (row) => row.topic);
      try {
        await Promise.all(
          [...byTopic].map(([topic, topicRows]) => p.send({ topic, messages: topicRows.map(toKafkaMessage) })),
        );
      } catch (err) {
        // Producer idempotent có thể rơi vào lỗi không gỡ được: lượt sau dựng producer mới.
        producer = undefined;
        await p.disconnect().catch(() => undefined);
        throw err;
      }
      await markPublished(rows.map((row) => row.id));
      return rows.length;
    });
  }

  async function run(): Promise<void> {
    const { signal } = controller;
    let lastCleanup = 0;
    while (!signal.aborted) {
      const full = (await retryUntilAborted('relay outbox', signal, tick)) === options.batchSize;
      if (Date.now() - lastCleanup >= options.cleanupEveryMs) {
        await cleanupOutbox(options.topicPrefix).catch((err: unknown) => outboxLogger.error({ err }, 'dọn outbox lỗi'));
        lastCleanup = Date.now();
      }
      if (!full) await sleep(options.pollMs, undefined, { signal }).catch(() => undefined);
    }
  }

  return {
    tick,
    start() {
      loop ??= run();
    },
    async stop() {
      controller.abort();
      // Không chờ lượt đang treo ở connect() (có thể vài phút khi broker chết); lượt đang gửi thì chờ tối đa
      // message.timeout.ms rồi bỏ: giao dịch chưa commit nên không dòng nào bị đánh dấu sai.
      await Promise.race([loop, sleep(options.messageTimeoutMs, undefined, { ref: false })]);
      await producer?.disconnect().catch(() => undefined);
    },
  };
}
