import client from 'prom-client';
import { metricsRegistry } from '../../../shared/observability/metrics.ts';
import type { InvitationStatus } from '../domain/invitation-machine.ts';

// Số liệu lời mời (#7 spec 6.12). `otp_requests_total`: `/join/otp` đếm `accepted`, `cooldown`, `limit`; consumer
// đếm `stale` (sự kiện cũ), `skipped` (lời mời đã đổi, đã gửi), `sent`. Lỗi gửi thư nằm ở `mail_send_total`.
export type OtpRequestResult = 'accepted' | 'cooldown' | 'limit' | 'stale' | 'skipped' | 'sent';

const otpRequests = new client.Counter({
  name: 'otp_requests_total',
  help: 'Số lần xin mã OTP lời mời theo kết quả',
  labelNames: ['result'] as const,
  registers: [metricsRegistry],
});

const transitions = new client.Counter({
  name: 'invitation_transitions_total',
  help: 'Số lần lời mời chuyển trạng thái, đếm sau khi giao dịch commit',
  labelNames: ['to'] as const,
  registers: [metricsRegistry],
});

export function countOtpRequest(result: OtpRequestResult): void {
  otpRequests.inc({ result });
}

export function countTransition(to: InvitationStatus): void {
  transitions.inc({ to });
}
