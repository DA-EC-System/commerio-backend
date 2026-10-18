// Khung sự kiện của platform (#38, Documents/21 §11 D4–D7): module khác phát và nghe qua đây, không biết Kafka.
// Hạ tầng Kafka chỉ được import trong src/modules/platform/service/outbox/. Cách dùng: README.md cùng thư mục.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { env } from '../../../../shared/config/env.ts';
import { currentCompanyId } from '../../../../shared/db/client.ts';
import { type EventEnvelope, topicOf } from '../../../../shared/events/envelope.ts';
import type { ModuleContext } from '../../../../shared/module.ts';
import { EVENT_SCHEMAS, type EventPayload, type EventType } from '../../domain/events.ts';
import { insertOutboxMessage } from '../../repository/outbox.ts';
import { type ConsumerScope, type Handler, register, startSharedConsumers } from './consumer.ts';
import { registerOutboxMetrics } from './metrics.ts';
import { createRelay } from './relay.ts';
import { outboxOptions } from './runtime.ts';

/**
 * Ghi sự kiện vào outbox trong giao dịch `withCompany` đang mở, trả `eventId`. Giao dịch rollback thì sự kiện
 * mất theo; commit thì relay của worker gửi lên Kafka. Gọi sai chỗ hay payload sai schema là lỗi lập trình (ném).
 * Role ứng dụng chỉ được INSERT vào outbox: `eventId` sinh ở đây, không dùng RETURNING.
 */
export async function publishEvent<T extends EventType>(event: {
  type: T;
  aggregateId: string;
  payload: EventPayload<T>;
}): Promise<string> {
  const payload = EVENT_SCHEMAS[event.type].safeParse(event.payload);
  if (!payload.success) throw new Error(`Payload của ${event.type} sai: ${z.prettifyError(payload.error)}`);
  // Chỉ khác null bên trong giao dịch của withCompany: ngoài giao dịch hay trong inTransaction đều bị chặn.
  const companyId = currentCompanyId();
  if (!companyId) throw new Error('publishEvent phải gọi trong giao dịch withCompany: sự kiện thuộc một công ty');
  const eventId = randomUUID();
  await insertOutboxMessage({
    eventId,
    companyId,
    type: event.type,
    topic: topicOf(event.type, env.KAFKA_TOPIC_PREFIX),
    key: event.aggregateId,
    payload: payload.data,
  });
  return eventId;
}

/**
 * Đăng ký xử lý một loại sự kiện. `shared` (mặc định): chạy trong worker, mỗi sự kiện một bản sao xử lý, handler
 * chạy dưới `withCompany` của sự kiện, chống trùng theo (consumer, eventId), lỗi thì thử lại 1 s/5 s/30 s rồi DLQ.
 * `instance`: chạy ngay trong tiến trình gọi (realtime), mọi bản sao đều nhận, không DB, không DLQ.
 * Đăng ký mọi loại của một consumer liền nhau trong một khối đồng bộ.
 */
export function registerConsumer<T extends EventType>(
  type: T,
  handler: (event: EventEnvelope<T, EventPayload<T>>) => Promise<void>,
  options: { consumer: string; scope?: ConsumerScope },
): void {
  // Handler đã được kiểm schema theo đúng `type` trước khi gọi (consumer.ts parseEnvelope).
  register(type, handler as unknown as Handler, options.consumer, options.scope ?? 'shared');
}

/** Worker: relay outbox, consumer `shared`, dọn dòng cũ, số liệu. Kafka chưa chạy thì tự nối lại, không chặn worker. */
export async function startOutboxBackground(_ctx: ModuleContext): Promise<() => Promise<void>> {
  const options = outboxOptions();
  const controller = new AbortController();
  registerOutboxMetrics(options.topicPrefix);
  const relay = createRelay(options);
  relay.start();
  const stopConsumers = startSharedConsumers(options, controller.signal);
  return async () => {
    controller.abort();
    await Promise.all([relay.stop(), stopConsumers()]);
  };
}
