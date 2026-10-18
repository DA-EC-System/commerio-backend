// Chỗ duy nhất trong repo import client Kafka (luật depcruise `kafka-chi-o-outbox`).
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { topicOf } from '../../../../shared/events/envelope.ts';
import { EVENT_TYPES } from '../../domain/events.ts';
import { logger } from '../../../../shared/logger.ts';
import type { OutboxOptions } from './runtime.ts';

export type Kafka = KafkaJS.Kafka;
export type Producer = KafkaJS.Producer;
export type Consumer = KafkaJS.Consumer;
export type EachMessagePayload = KafkaJS.EachMessagePayload;
export type IHeaders = KafkaJS.IHeaders;

/** Số partition của mọi topic sự kiện (Documents/21 D6); giới hạn trên của số worker xử lý song song. */
const PARTITIONS = 3;

const kafkaLog = logger.child({ component: 'kafka' });
const toPino = (level: 'info' | 'warn' | 'error' | 'debug') => (entry: { message?: string } | string) =>
  typeof entry === 'string' ? kafkaLog[level](entry) : kafkaLog[level](entry, entry.message ?? '');
const pinoLogger: KafkaJS.Logger = {
  info: toPino('info'),
  warn: toPino('warn'),
  error: toPino('error'),
  debug: toPino('debug'),
  namespace: () => pinoLogger,
  setLogLevel: () => undefined,
};

export function createKafka(options: OutboxOptions): Kafka {
  return new KafkaJS.Kafka({
    // Trên Windows `localhost` thử ::1 trước, mỗi lần nối mất ~2 s và admin hết giờ (ground-truth #38).
    'broker.address.family': 'v4',
    kafkaJS: { brokers: [...options.brokers], clientId: options.clientId, logger: pinoLogger },
  });
}

/** Producer giữ thứ tự theo partition kể cả khi gửi lại (idempotent). */
export function createProducer(kafka: Kafka, options: OutboxOptions): Producer {
  return kafka.producer({ 'enable.idempotence': true, 'message.timeout.ms': options.messageTimeoutMs });
}

/** Topic của mọi module có sự kiện trong danh mục. */
export function eventTopics(prefix: string): string[] {
  return [...new Set(EVENT_TYPES.map((type) => topicOf(type, prefix)))];
}

/**
 * Tạo topic còn thiếu kèm `<topic>.dlq`. Consumer nghe topic chưa có thì không lỗi mà cũng không tạo nó,
 * nên phải tạo trước. Tạo lại topic đã có trả `false`, không ném.
 */
export async function ensureTopics(kafka: Kafka, topics: readonly string[]): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    await admin.createTopics({
      topics: topics.flatMap((topic) => [topic, `${topic}.dlq`]).map((topic) => ({ topic, numPartitions: PARTITIONS })),
    });
  } finally {
    await admin.disconnect();
  }
}
