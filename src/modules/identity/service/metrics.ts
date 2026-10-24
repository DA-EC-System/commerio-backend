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

// Bước nhập mã 2FA và xác nhận thiết lập (#7 [D]): `replay` là mã đúng nhưng đã dùng; `recovery` là đăng nhập bằng mã
// khôi phục; `locked` là bị chặn vì sai 5 lần trong 15 phút.
export type TwoFactorOutcome = 'ok' | 'invalid' | 'replay' | 'recovery' | 'locked';

const twoFactor = new client.Counter({
  name: 'two_factor_verifications_total',
  help: 'Số lần kiểm mã xác thực hai lớp theo kết quả',
  labelNames: ['result'] as const,
  registers: [metricsRegistry],
});

export function countTwoFactor(result: TwoFactorOutcome): void {
  twoFactor.inc({ result });
}
