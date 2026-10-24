import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  // Cổng nội bộ của api cho /metrics; worker và realtime dùng luôn cổng của mình làm cổng vận hành.
  API_OPS_PORT: z.coerce.number().int().positive().default(9464),
  WORKER_PORT: z.coerce.number().int().positive().default(3001),
  REALTIME_PORT: z.coerce.number().int().positive().default(3002),
  // Cổng vận hành của realtime (/health, /metrics), tách khỏi cổng stream mà proxy đưa ra ngoài.
  REALTIME_OPS_PORT: z.coerce.number().int().positive().default(3003),
  // Swagger UI ở /api/docs. Tắt khi chạy production thật.
  API_DOCS_ENABLED: z.stringbool().default(true),
  // Không bắt buộc lúc khởi động để test không cần DB; getDb() báo lỗi nếu thiếu.
  DATABASE_URL: z.string().min(1).optional(),
  // Cặp khoá Ed25519 dạng PEM ký access token; xuống dòng trong PEM viết `\n` được.
  // Thiếu thì máy dev tự sinh khoá tạm (token mất hiệu lực khi khởi động lại); production bắt buộc có.
  JWT_PRIVATE_KEY: z.string().min(1).optional(),
  JWT_PUBLIC_KEY: z.string().min(1).optional(),
  // Số lần gọi đăng nhập, đăng ký mỗi 15 phút cho một IP.
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(20),
  // Số tầng proxy đứng trước api (Caddy, Ingress) để req.ip là IP thật của khách; máy dev chạy thẳng thì 0.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  KAFKA_BROKERS: z.string().min(1).default('localhost:9092'),
  KAFKA_CLIENT_ID: z.string().min(1).default('commerio'),
  // Topic là <tiền tố>.<module>; mỗi worktree chạy song song đặt tiền tố riêng để không tiêu sự kiện của nhau.
  KAFKA_TOPIC_PREFIX: z.string().min(1).default('commerio'),
  // Khoá mã hoá khoá cổng thanh toán lưu trong DB: 32 byte, base64.
  PAYMENT_CREDENTIALS_KEY: z
    .string()
    .refine((s) => Buffer.from(s, 'base64').length === 32, 'Cần 32 byte dạng base64')
    .optional(),
  // Khoá mã hoá secret TOTP của 2FA (#7 [D]), riêng với khoá cổng thanh toán: 32 byte, base64.
  TOTP_ENCRYPTION_KEY: z
    .string()
    .refine((s) => Buffer.from(s, 'base64').length === 32, 'Cần 32 byte dạng base64')
    .optional(),
  // `required`: mọi tài khoản phải bật 2FA (#7 [D]); `off` (mặc định): luồng đăng nhập, tham gia như chưa có 2FA.
  TWO_FACTOR_MODE: z.enum(['off', 'required']).default('off'),
  // URL công khai của api, dùng làm địa chỉ IPN và trang quay về cho cổng thanh toán.
  PUBLIC_API_URL: z.url().optional(),
  // URL công khai của FE: cổng thanh toán đưa khách quay về `<PUBLIC_WEB_URL>/thanh-toan/ket-qua`.
  PUBLIC_WEB_URL: z.url().optional(),
  // Nhân ngưỡng giới hạn tần suất của /identity/join/* (#7 spec 6.11); test đặt lớn để không chạm ngưỡng.
  JOIN_RATE_LIMIT_SCALE: z.coerce.number().positive().default(1),
  // OAuth client ID loại Web của Google (Google Identity Services, #7): `aud` của ID token phải bằng giá trị này.
  // BE không cần client secret. Thiếu thì `POST /identity/google` trả 503 `google_unavailable`.
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  // Gửi thư (OTP mời nhân viên, #7): Gmail `smtps://<địa chỉ>:<App Password>@smtp.gmail.com:465` ở staging,
  // Mailpit `smtp://localhost:1025` ở máy dev. Thiếu thì worker vẫn chạy, mỗi lần gửi báo lỗi vĩnh viễn.
  SMTP_URL: z.url({ protocol: /^smtps?$/ }).optional(),
  // Người gửi, vd `Commerio <ten@gmail.com>`; Gmail đòi trùng tài khoản đăng nhập SMTP.
  MAIL_FROM: z.string().min(3).optional(),
});

export type Env = z.infer<typeof EnvSchema>;

// Bật 2FA bắt buộc mà thiếu khoá mã hoá secret thì không khởi động.
const CheckedEnvSchema = EnvSchema.refine((e) => e.TWO_FACTOR_MODE === 'off' || e.TOTP_ENCRYPTION_KEY !== undefined, {
  path: ['TOTP_ENCRYPTION_KEY'],
  message: 'TWO_FACTOR_MODE=required cần TOTP_ENCRYPTION_KEY',
});

function loadEnv(): Env {
  const result = CheckedEnvSchema.safeParse(process.env);
  if (!result.success) {
    throw new Error(`Biến môi trường không hợp lệ:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export const env = loadEnv();
