// Gửi thư qua SMTP (#7 spec 6.8). Chỉ worker gửi thư (docs/17 mục 4), không gửi trong request HTTP.
// Lỗi chia hai loại để bên gọi quyết định thử lại: `transient` (mạng, timeout, mã SMTP 4xx) ném lại để outbox thử lại,
// `permanent` (mã 5xx, sai xác thực SMTP, chưa cấu hình) thì không. Lỗi không chép phản hồi SMTP (có thể chứa địa chỉ).
import client from 'prom-client';
import { env } from '../config/env.ts';
import { metricsRegistry } from '../observability/metrics.ts';
import { MAIL_TIMEOUT_MS, type MailTransport, smtpTransportFromEnv } from './transport.ts';

export type { MailTransport } from './transport.ts';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export type MailErrorKind = 'transient' | 'permanent';

export class MailError extends Error {
  readonly kind: MailErrorKind;
  /** Mã trả lời SMTP (vd 550) hoặc mã lỗi của nodemailer (vd `EAUTH`), không có nội dung trả lời. */
  readonly smtpCode: number | string | undefined;

  constructor(kind: MailErrorKind, reason: string, smtpCode?: number | string) {
    super(reason);
    this.name = 'MailError';
    this.kind = kind;
    this.smtpCode = smtpCode;
  }
}

const TRANSIENT_CODES = new Set(['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS']);

export function classifyMailError(err: unknown): MailErrorKind {
  const { code, responseCode } = (typeof err === 'object' && err !== null ? err : {}) as {
    code?: unknown;
    responseCode?: unknown;
  };
  if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return 'transient';
  if (code === 'EAUTH') return 'permanent';
  if (typeof responseCode === 'number' && responseCode >= 500) return 'permanent';
  return 'transient';
}

const sent = new client.Counter({
  name: 'mail_send_total',
  help: 'Số lần gửi thư theo mẫu và kết quả (ok, transient, permanent)',
  labelNames: ['template', 'result'] as const,
  registers: [metricsRegistry],
});

const duration = new client.Histogram({
  name: 'mail_send_duration_seconds',
  help: 'Thời gian một lần gửi thư qua SMTP',
  labelNames: ['template'] as const,
  registers: [metricsRegistry],
});

let override: MailTransport | null = null;
let fromEnv: MailTransport | null | undefined;

/** Test đặt transport giả; `null` thì quay lại transport dựng từ `SMTP_URL`. */
export function setMailTransport(transport: MailTransport | null): void {
  override = transport;
}

function currentTransport(): MailTransport | null {
  if (override) return override;
  fromEnv ??= smtpTransportFromEnv();
  return fromEnv;
}

function toMailError(err: unknown): MailError {
  const { code, responseCode } = (typeof err === 'object' && err !== null ? err : {}) as {
    code?: unknown;
    responseCode?: unknown;
  };
  const smtpCode = typeof responseCode === 'number' ? responseCode : typeof code === 'string' ? code : undefined;
  const kind = classifyMailError(err);
  return new MailError(kind, `Gửi thư lỗi ${kind === 'transient' ? 'tạm thời' : 'vĩnh viễn'}`, smtpCode);
}

async function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new MailError('transient', `Gửi thư quá ${MAIL_TIMEOUT_MS / 1000} giây`)),
      MAIL_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Gửi một thư. Ném `MailError`; `template` là tên mẫu thư, dùng làm nhãn metric. */
export async function sendMail(message: MailMessage, template: string): Promise<void> {
  const stop = duration.startTimer({ template });
  try {
    const transport = currentTransport();
    if (!transport || !env.MAIL_FROM) throw new MailError('permanent', 'Chưa cấu hình SMTP_URL hoặc MAIL_FROM');
    await withTimeout(transport.sendMail({ from: env.MAIL_FROM, ...message }));
    sent.inc({ template, result: 'ok' });
  } catch (err) {
    const mailErr = err instanceof MailError ? err : toMailError(err);
    sent.inc({ template, result: mailErr.kind });
    throw mailErr;
  } finally {
    stop();
  }
}
