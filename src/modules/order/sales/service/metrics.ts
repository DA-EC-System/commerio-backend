// Số liệu của việc nền tự hoàn tất đơn trên /metrics của worker (#236). Chỉ đăng ký khi worker chạy việc nền của sales
// (`startSalesBackground`), như `registerOutboxMetrics`; chưa đăng ký thì ghi số không làm gì (api, test).
import client from 'prom-client';
import { metricsRegistry } from '../../../../shared/observability/metrics.ts';

let metrics:
  | {
      completed: client.Counter;
      cancelled: client.Counter;
      failures: client.Counter<'scope'>;
      lastRun: client.Gauge;
    }
  | undefined;

export function registerSalesMetrics(): void {
  if (metrics) return;
  metrics = {
    completed: new client.Counter({
      name: 'sales_orders_auto_completed_total',
      help: 'Số đơn việc nền đã tự hoàn tất',
      registers: [metricsRegistry],
    }),
    cancelled: new client.Counter({
      name: 'sales_orders_auto_cancelled_total',
      help: 'Số đơn mọi kiện đã huỷ mà việc nền đã huỷ (platform_cancel đơn sàn, auto_cancel đơn khác; #236)',
      registers: [metricsRegistry],
    }),
    // Không nhãn theo công ty, đơn để không nổ số chuỗi.
    failures: new client.Counter({
      name: 'sales_auto_complete_failures_total',
      help: 'Số lỗi của việc nền tự hoàn tất: một đơn (order) hay cả lô đọc của một công ty (company)',
      labelNames: ['scope'] as const,
      registers: [metricsRegistry],
    }),
    lastRun: new client.Gauge({
      name: 'sales_auto_complete_last_run_timestamp_seconds',
      help: 'Lúc (giây Unix) lượt tự hoàn tất gần nhất chạy hết, kể cả có đơn lỗi',
      registers: [metricsRegistry],
    }),
  };
}

/** Ghi kết quả một lượt đã chạy hết. */
export function recordAutoComplete(r: { completed: number; cancelled: number; failedOrders: number; skippedCompanies: number }): void {
  if (!metrics) return;
  metrics.completed.inc(r.completed);
  metrics.cancelled.inc(r.cancelled);
  metrics.failures.inc({ scope: 'order' }, r.failedOrders);
  metrics.failures.inc({ scope: 'company' }, r.skippedCompanies);
  metrics.lastRun.set(Date.now() / 1000);
}
