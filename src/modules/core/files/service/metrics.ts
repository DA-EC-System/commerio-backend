import client from 'prom-client';
import { metricsRegistry } from '../../../../shared/observability/metrics.ts';
import type { FilePurpose } from '../domain/upload-rules.ts';

// Số liệu cấp vé tải tệp trên /metrics của api (#212). `quota_exceeded` tăng là kho sắp chạm gói miễn phí của R2.
export type TicketResult = 'ok' | 'file_type_not_allowed' | 'file_too_large' | 'unavailable' | 'quota_exceeded';

const tickets = new client.Counter({
  name: 'files_upload_tickets_total',
  help: 'Số lần xin vé tải tệp lên theo mục đích và kết quả',
  labelNames: ['purpose', 'result'] as const,
  registers: [metricsRegistry],
});

export function countTicket(purpose: FilePurpose, result: TicketResult): void {
  tickets.inc({ purpose, result });
}
