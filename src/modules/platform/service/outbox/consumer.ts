import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { DrizzleQueryError } from 'drizzle-orm';
import { z } from 'zod';
import { withCompany } from '../../../../shared/db/client.ts';
import { type EventEnvelope, topicOf } from '../../../../shared/events/envelope.ts';
import { EVENT_SCHEMAS, type EventType } from '../../domain/events.ts';
import { markProcessed } from '../../repository/outbox.ts';
import {
  type Consumer,
  createKafka,
  createProducer,
  type EachMessagePayload,
  ensureTopics,
  type IHeaders,
  type Kafka,
  type Producer,
} from './kafka.ts';
import { countDeadLettered } from './metrics.ts';
import { type OutboxOptions, outboxLogger } from './runtime.ts';

/**
 * `shared`: một group cho mọi bản sao worker, mỗi sự kiện một bản xử lý, chống trùng bằng `processed_events`,
 * thử lại rồi DLQ. `instance`: mỗi tiến trình một group riêng (realtime), nhận mọi sự kiện mới, không DB, không DLQ.
 */
export type ConsumerScope = 'shared' | 'instance';
// Handler nhận envelope đã kiểm schema; kiểu chi tiết theo loại nằm ở chữ ký `registerConsumer`.
export type Handler = (event: EventEnvelope<EventType>) => Promise<void>;

export interface ConsumerSpec {
  readonly consumer: string;
  readonly scope: ConsumerScope;
  readonly handlers: ReadonlyMap<string, Handler>;
}

// ---------- Quyết định cho một message (thuần, test không cần Kafka) ----------

export interface IncomingMessage {
  readonly topic: string;
  readonly partition: number;
  readonly offset: string;
  readonly key: Buffer | null;
  readonly headers?: IHeaders | undefined;
  readonly value: Buffer | null;
}

export interface ProcessDeps {
  readonly spec: ConsumerSpec;
  readonly retryDelaysMs: readonly number[];
  /** Chạy handler trong ngữ cảnh của sự kiện (bỏ qua nếu đã xử lý rồi). Lỗi của handler bọc `HandlerFailure`. */
  runHandler(envelope: EventEnvelope<EventType>, handler: Handler): Promise<void>;
  sendToDlq(message: IncomingMessage, reason: string, attempts: number): Promise<void>;
}

export type Decision = { kind: 'done' } | { kind: 'retry'; delayMs: number };

/** Lỗi ném ra từ chính handler, phân biệt với lỗi hạ tầng (mở giao dịch, ghi processed_events). */
export class HandlerFailure extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);

/**
 * Lỗi mất kết nối **PostgreSQL**: SQLSTATE lớp `08` hay server cắt (`57P01..03`), "Connection terminated" của `pg`
 * (không có mã), hoặc mã mạng của Node nằm dưới một `DrizzleQueryError`. Mã mạng không kèm truy vấn DB (vd handler
 * gọi API sàn lỗi) là lỗi của handler: thử lại rồi DLQ. Drizzle bọc lỗi truy vấn, mã nằm ở `.cause`, nên xét cả chuỗi.
 */
export function isConnectionError(err: unknown): boolean {
  let underQuery = false;
  for (let e = err, depth = 0; e instanceof Error && depth < 5; e = e.cause, depth++) {
    if (e instanceof DrizzleQueryError) underQuery = true;
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && (code.startsWith('08') || /^57P0[123]$/.test(code))) return true;
    if (typeof code === 'string' && underQuery && NETWORK_CODES.has(code)) return true;
    if (e.message.includes('Connection terminated')) return true;
  }
  return false;
}

/** Lý do ghi vào DLQ: bỏ phần `params:` mà Drizzle gắn vào thông báo (có thể là dữ liệu khách), cắt 4 000 ký tự. */
function dlqReason(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text.split('\nparams:')[0]!.slice(0, 4_000);
}

const header = (headers: IHeaders | undefined, name: string): string | undefined => {
  const value = headers?.[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined ? undefined : first.toString();
};

const EnvelopeSchema = z.object({
  eventId: z.uuid(),
  type: z.string(),
  companyId: z.uuid().nullable(),
  aggregateId: z.string().min(1),
  occurredAt: z.iso.datetime({ offset: true }),
  payload: z.unknown(),
});

function parseEnvelope(type: string, value: Buffer | null): EventEnvelope<EventType> | string {
  let json: unknown;
  try {
    json = JSON.parse(value?.toString() ?? '');
  } catch {
    return 'value không phải JSON';
  }
  const envelope = EnvelopeSchema.safeParse(json);
  if (!envelope.success) return `envelope sai: ${z.prettifyError(envelope.error)}`;
  if (envelope.data.type !== type) return `header type ${type} khác envelope ${envelope.data.type}`;
  const payload = EVENT_SCHEMAS[type as EventType].safeParse(envelope.data.payload);
  if (!payload.success) return `payload sai: ${z.prettifyError(payload.error)}`;
  return { ...envelope.data, type: type as EventType, payload: payload.data };
}

/**
 * Xử lý một message, `attempt` = số lần handler đã lỗi trước đó. Lỗi handler → thử lại theo lịch rồi DLQ.
 * Lỗi hạ tầng (DB, gửi DLQ) thì **ném**, để bên gọi trả message về Kafka giao lại thay vì đẩy nhầm vào DLQ.
 */
export async function processMessage(message: IncomingMessage, attempt: number, deps: ProcessDeps): Promise<Decision> {
  const { spec } = deps;
  // Xét đăng ký trước khi kiểm schema: message hỏng chỉ vào DLQ từ group thật sự nghe loại đó.
  const type = header(message.headers, 'type');
  const handler = type && spec.handlers.get(type);
  if (!handler) return { kind: 'done' };

  const parsed = parseEnvelope(type, message.value);
  let invalid: string | null = null;
  if (typeof parsed === 'string') invalid = parsed;
  // Sự kiện cấp nền tảng chưa có loại nào; handler `shared` cần công ty để chạy dưới RLS.
  else if (spec.scope === 'shared' && parsed.companyId === null) invalid = 'companyId trống';
  if (invalid !== null || typeof parsed === 'string') {
    if (spec.scope === 'shared') await deps.sendToDlq(message, invalid ?? '', 0);
    else outboxLogger.warn({ consumer: spec.consumer, topic: message.topic, reason: invalid }, 'bỏ qua sự kiện sai');
    return { kind: 'done' };
  }

  try {
    await deps.runHandler(parsed, handler);
    return { kind: 'done' };
  } catch (err) {
    if (!(err instanceof HandlerFailure)) throw err;
    // instance (realtime) không DB, không thử lại: lỗi gì cũng chỉ ghi log.
    if (spec.scope === 'instance') {
      outboxLogger.error({ reason: dlqReason(err.cause), consumer: spec.consumer, eventId: parsed.eventId }, 'handler lỗi');
      return { kind: 'done' };
    }
    if (isConnectionError(err.cause)) throw err;
    const delayMs = deps.retryDelaysMs[attempt];
    if (delayMs !== undefined) return { kind: 'retry', delayMs };
    await deps.sendToDlq(message, dlqReason(err.cause), attempt + 1);
    return { kind: 'done' };
  }
}

// ---------- Runner: một consumer Kafka cho một tên consumer ----------

export interface ConsumerRunner {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Partition đang được giao (để test chờ chia xong). */
  assignment(): { topic: string; partition: number }[];
}

/** Ngữ cảnh chạy handler `shared`: giao dịch của công ty (RLS), ghi `processed_events` cùng giao dịch (AC-4). */
async function runShared(consumer: string, envelope: EventEnvelope<EventType>, handler: Handler): Promise<void> {
  await withCompany(envelope.companyId!, async () => {
    if (await markProcessed(consumer, envelope.eventId)) await callHandler(envelope, handler);
  });
}

async function callHandler(envelope: EventEnvelope<EventType>, handler: Handler): Promise<void> {
  try {
    await handler(envelope);
  } catch (err) {
    throw new HandlerFailure(err);
  }
}

class StoppedError extends Error {}

export function createConsumerRunner(options: OutboxOptions, spec: ConsumerSpec, kafka: Kafka = createKafka(options)): ConsumerRunner {
  const shared = spec.scope === 'shared';
  const groupId = shared
    ? `${options.topicPrefix}.${spec.consumer}`
    : `${options.topicPrefix}.${spec.consumer}.${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  const topics = [...new Set([...spec.handlers.keys()].map((type) => topicOf(type, options.topicPrefix)))];
  const attempts = new Map<string, number>();
  const timers = new Set<NodeJS.Timeout>();
  let infraFailures = 0;
  let stopped = false;
  let consumer: Consumer | undefined;
  let dlqProducer: Producer | undefined;

  const deps: ProcessDeps = {
    spec,
    retryDelaysMs: options.retryDelaysMs,
    runHandler: (envelope, handler) => (shared ? runShared(spec.consumer, envelope, handler) : callHandler(envelope, handler)),
    async sendToDlq(message, reason, attemptCount) {
      await dlqProducer!.send({
        topic: `${message.topic}.dlq`,
        messages: [
          {
            key: message.key,
            value: message.value,
            headers: {
              ...message.headers,
              'x-error': reason,
              'x-original-topic': message.topic,
              'x-original-partition': String(message.partition),
              'x-original-offset': message.offset,
              'x-attempts': String(attemptCount),
              'x-consumer': spec.consumer,
              'x-failed-at': new Date().toISOString(),
            },
          },
        ],
      });
      countDeadLettered(message.topic, spec.consumer);
      outboxLogger.error({ consumer: spec.consumer, topic: message.topic, offset: message.offset, reason }, 'sự kiện sang DLQ');
    },
  };

  async function eachMessage({ topic, partition, message, pause }: EachMessagePayload): Promise<void> {
    const key = `${topic}:${partition}:${message.offset}`;
    const attempt = attempts.get(key) ?? 0;
    const incoming: IncomingMessage = { topic, partition, ...message };
    let delayMs: number;
    try {
      const decision = await processMessage(incoming, attempt, deps);
      infraFailures = 0;
      if (decision.kind === 'done') {
        attempts.delete(key);
        return;
      }
      attempts.set(key, attempt + 1);
      delayMs = decision.delayMs;
      outboxLogger.warn({ consumer: spec.consumer, topic, partition, offset: message.offset, attempt: attempt + 1, delayMs }, 'handler lỗi, sẽ thử lại');
    } catch (err) {
      // DB chết lâu thì không gõ cửa mỗi giây: chờ lùi 1 s → 30 s.
      delayMs = Math.min(1_000 * 2 ** infraFailures++, 30_000);
      outboxLogger.error({ reason: dlqReason(err), consumer: spec.consumer, topic, partition, offset: message.offset }, 'lỗi hạ tầng khi xử lý sự kiện, giao lại');
    }
    // Dừng riêng partition này rồi ném: client tua lại đúng offset, không lưu offset, partition khác chạy tiếp.
    const resume = pause();
    const timer = setTimeout(() => {
      timers.delete(timer);
      try {
        resume();
      } catch {
        // partition đã bị thu hồi khi rebalance: bản sao nhận nó sẽ đọc lại từ offset chưa commit
      }
    }, delayMs);
    timers.add(timer);
    throw new Error(`Thử lại ${key} sau ${delayMs} ms`);
  }

  return {
    async start() {
      // Gọi lại được sau khi lỗi (retryUntilAborted): ngắt phần đã nối của lần hỏng; đã dừng giữa chừng thì bỏ.
      try {
        await ensureTopics(kafka, topics);
        if (shared) {
          dlqProducer = createProducer(kafka, options);
          await dlqProducer.connect();
        }
        consumer = kafka.consumer({ kafkaJS: { groupId, fromBeginning: shared, autoCommit: shared } });
        await consumer.connect();
        await consumer.subscribe({ topics });
        if (stopped) throw new StoppedError();
        await consumer.run({ eachMessage });
      } catch (err) {
        await consumer?.disconnect().catch(() => undefined);
        await dlqProducer?.disconnect().catch(() => undefined);
        consumer = dlqProducer = undefined;
        // Đã dừng giữa lúc khởi động: xong êm, để retryUntilAborted không gọi lại mãi.
        if (!(err instanceof StoppedError)) throw err;
      }
    },
    async stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      await consumer?.disconnect().catch(() => undefined);
      await dlqProducer?.disconnect().catch(() => undefined);
    },
    assignment: () => consumer?.assignment() ?? [],
  };
}
