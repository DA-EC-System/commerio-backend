import client from 'prom-client';
import { metricsRegistry } from '../../../shared/observability/metrics.ts';

// Số liệu đăng nhập trên /metrics của api (#7 spec 6.12).
export type LoginMethod = 'password' | 'google' | 'mfa';
export type LoginOutcome = 'ok' | 'invalid' | 'not_found' | 'unavailable' | 'mfa_required';

const logins = new client.Counter({
  name: 'auth_login_total',
  help: 'Số lần đăng nhập theo cách và kết quả',
  labelNames: ['method', 'result'] as const,
  registers: [metricsRegistry],
});

export function countLogin(method: LoginMethod, result: LoginOutcome): void {
  logins.inc({ method, result });
}
