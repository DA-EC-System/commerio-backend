import client from 'prom-client';
import { metricsRegistry } from '../../../../shared/observability/metrics.ts';
import { pendingStats } from '../../repository/outbox.ts';
import { outboxLogger } from './runtime.ts';

// Số liệu của outbox trên /metrics của worker (cho #36). Chỉ đăng ký khi worker chạy outbox, để api không truy vấn outbox.
let deadLettered: client.Counter<'topic' | 'consumer'> | undefined;

export function registerOutboxMetrics(prefix: string): void {
  if (deadLettered) return;
  // Mỗi gauge một truy vấn: prom-client đọc các metric song song, gộp thì một gauge trễ một lần lấy số.
  const read = async (pick: (s: { count: number; oldestAgeSeconds: number }) => number) => {
    try {
      return pick(await pendingStats(prefix));
    } catch (err) {
      outboxLogger.error({ err }, 'đọc số liệu outbox lỗi');
      return Number.NaN;
    }
  };
  new client.Gauge({
    name: 'outbox_pending_messages',
    help: 'Số sự kiện trong outbox chưa gửi lên Kafka',
    registers: [metricsRegistry],
    async collect() {
      this.set(await read((s) => s.count));
    },
  });
  new client.Gauge({
    name: 'outbox_oldest_pending_age_seconds',
    help: 'Tuổi (giây) của sự kiện chưa gửi cũ nhất; 0 khi không còn',
    registers: [metricsRegistry],
    async collect() {
      this.set(await read((s) => s.oldestAgeSeconds));
    },
  });
  deadLettered = new client.Counter({
    name: 'outbox_dead_lettered_total',
    help: 'Số sự kiện consumer đã chuyển sang DLQ',
    labelNames: ['topic', 'consumer'] as const,
    registers: [metricsRegistry],
  });
}

export function countDeadLettered(topic: string, consumer: string): void {
  deadLettered?.inc({ topic, consumer });
}
