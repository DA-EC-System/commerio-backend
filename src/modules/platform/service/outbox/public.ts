// Khung của #38 (outbox → Kafka): chữ ký đã chốt (Documents/21 §11), #38 viết thân trong thư mục này,
// không sửa platform/index.ts. Hạ tầng Kafka chỉ được import trong src/modules/platform/service/outbox/.
import type { ModuleContext } from '../../../../shared/module.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import type { EventEnvelope } from '../../../../shared/events/envelope.ts';
import { logger } from '../../../../shared/logger.ts';
import type { EventPayload, EventType } from '../../domain/events.ts';

const notImplemented = (fn: string) => new AppError(501, 'not_implemented', `${fn} chưa làm (#38)`);

/**
 * Ghi sự kiện vào outbox trong giao dịch đang mở (`withCompany` hoặc `inTransaction`), trả `eventId`.
 * Role ứng dụng chỉ được INSERT vào outbox: sinh `eventId` ở ứng dụng, không dùng RETURNING.
 */
export async function publishEvent<T extends EventType>(_event: {
  type: T;
  aggregateId: string;
  payload: EventPayload<T>;
}): Promise<string> {
  throw notImplemented('publishEvent');
}

/** Đăng ký xử lý một loại sự kiện; chống xử lý trùng theo (consumer, eventId) ở `platform.processed_events`. */
export function registerConsumer<T extends EventType>(
  _type: T,
  _handler: (event: EventEnvelope<T, EventPayload<T>>) => Promise<void>,
  _options: { consumer: string },
): void {
  throw notImplemented('registerConsumer');
}

/** Relay outbox và chạy consumer trong worker. Chưa làm thì không chạy gì, để worker vẫn lên được. */
export async function startOutboxBackground(_ctx: ModuleContext): Promise<() => Promise<void>> {
  logger.warn('Relay outbox chưa làm (#38): worker không đẩy sự kiện lên Kafka');
  return async () => undefined;
}
