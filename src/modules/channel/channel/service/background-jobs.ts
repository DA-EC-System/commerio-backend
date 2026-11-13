// Chỗ duy nhất channel đăng ký việc nền (#215, Documents/21 §18.6.8): mọi handler pg-boss và consumer Kafka của channel
// chạy dưới `inBackground`, nên lời gọi sàn trong đó dùng tới hết phần hạn mức của công ty; thao tác bấm tay (request
// HTTP) dừng ở 90%. `test/unit/modules/channel/channel/service/background-jobs.test.ts` chặn gọi thẳng `workQueue`,
// `registerConsumer` của core ở chỗ khác trong channel.
import {
  type EventEnvelope,
  type EventPayload,
  type EventType,
  type JobAttempt,
  type JobData,
  type Queue,
  registerConsumer,
  workQueue,
} from '../../../core/index.ts';
import { inBackground } from './marketplaces/index.ts';

/** `workQueue` của core, handler chạy như việc nền. */
export function workChannelQueue<T extends JobData>(
  queue: Queue<T>,
  handler: (data: T, attempt: JobAttempt) => Promise<void>,
  options: { concurrency?: number } = {},
): Promise<void> {
  return workQueue(queue, (data, attempt) => inBackground(() => handler(data, attempt)), options);
}

/** `registerConsumer` của core, handler chạy như việc nền. */
export function registerChannelConsumer<T extends EventType>(
  type: T,
  handler: (event: EventEnvelope<T, EventPayload<T>>) => Promise<void>,
  options: { consumer: string },
): void {
  registerConsumer(type, (event) => inBackground(() => handler(event)), options);
}
