// Nghe sự kiện cho thông báo trong tiến trình realtime: consumer `instance`, mỗi bản sao một group nên bản nào cũng nhận đủ.
import client from 'prom-client';
import { metricsRegistry } from '../../../../shared/observability/metrics.ts';
import { type EventEnvelope, type EventType, registerConsumer } from '../../platform/index.ts';
import { NOTIFIED_TYPES } from '../domain/rules.ts';
import type { Hub } from './hub.ts';

const CONSUMER = 'notification-sse';

/** Loại sự kiện → handler đẩy vào hub. Test Kafka dựng consumer runner từ bảng này. */
export function notificationHandlers(hub: Hub): ReadonlyMap<string, (event: EventEnvelope<EventType>) => Promise<void>> {
  return new Map(NOTIFIED_TYPES.map((type) => [type, async (event: EventEnvelope<EventType>) => hub.dispatch(event)]));
}

let started = false;

/** Gọi một lần lúc realtime khởi động: đăng ký mọi loại liền một khối, và số kết nối đang mở trên /metrics. */
export function startNotifications(hub: Hub): void {
  if (started) return;
  started = true;
  for (const [type, handler] of notificationHandlers(hub)) {
    registerConsumer(type as EventType, handler, { consumer: CONSUMER, scope: 'instance' });
  }
  new client.Gauge({
    name: 'notification_open_streams',
    help: 'Số kết nối SSE thông báo đang mở trên tiến trình realtime này',
    registers: [metricsRegistry],
    collect() {
      this.set(hub.size());
    },
  });
}
