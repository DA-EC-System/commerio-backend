// Transport SMTP thật, dựng từ `SMTP_URL`: Gmail ở staging (`smtps://<địa chỉ>:<App Password>@smtp.gmail.com:465`),
// Mailpit ở máy dev (`smtp://localhost:1025`). Test thay bằng transport giả qua `setMailTransport` (index.ts).
import nodemailer from 'nodemailer';
import { env } from '../config/env.ts';

/** Mỗi lần gửi tối đa 10 giây, kể cả kết nối và chào hỏi (#7 spec 6.7). */
export const MAIL_TIMEOUT_MS = 10_000;

export type MailTransport = {
  sendMail(options: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
};

/** `null` khi chưa đặt `SMTP_URL`. */
export function smtpTransportFromEnv(): MailTransport | null {
  if (!env.SMTP_URL) return null;
  const url = new URL(env.SMTP_URL);
  const secure = url.protocol === 'smtps:';
  return nodemailer.createTransport({
    host: url.hostname,
    port: url.port ? Number(url.port) : secure ? 465 : 587,
    secure,
    auth: url.username
      ? { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) }
      : undefined,
    connectionTimeout: MAIL_TIMEOUT_MS,
    greetingTimeout: MAIL_TIMEOUT_MS,
    socketTimeout: MAIL_TIMEOUT_MS,
  });
}
