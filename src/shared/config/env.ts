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
  // Hạn dùng lại refresh token vừa xoay vòng, giây (F5 hai lần, nhiều tab refresh cùng lúc). Quá hạn là dùng lại:
  // thu hồi cả họ token. 0 thì tắt hạn dùng lại.
  REFRESH_REUSE_GRACE_SECONDS: z.coerce.number().int().min(0).max(300).default(30),
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
  // Khoá mã hoá token sàn của gian hàng lưu trong DB (#103): 32 byte, base64.
  CHANNEL_TOKEN_KEY: z
    .string()
    .refine((s) => Buffer.from(s, 'base64').length === 32, 'Cần 32 byte dạng base64')
    .optional(),
  // App Lazada (Documents/tich-hop-san/lazada.md §1). Thiếu thì các route kết nối Lazada trả 422 `marketplace_unsupported`.
  LAZADA_APP_KEY: z.string().min(1).optional(),
  LAZADA_APP_SECRET: z.string().min(1).optional(),
  LAZADA_REDIRECT_URL: z.url().optional(),
  // Đổi sang sàn giả lập (#115) bằng hai biến này.
  LAZADA_API_URL: z.url().default('https://api.lazada.vn/rest'),
  LAZADA_AUTH_URL: z.url().default('https://auth.lazada.com'),
  // Hạn mức gọi Lazada mỗi ngày của cả app (App Console: 10.000), chừa 10% cho thao tác tay và lệch múi giờ (#102 A7).
  LAZADA_DAILY_CALL_LIMIT: z.coerce.number().int().positive().default(9000),
  // App TikTok Shop loại Custom (#217, Documents/tich-hop-san/tiktok.md §1). Key + secret: nối bằng dán token; thêm
  // TIKTOK_SERVICE_ID: nối OAuth. TIKTOK_REDIRECT_URL chỉ để ghi chú: TikTok dùng Redirect URL khai trong app, link uỷ
  // quyền không mang redirect_uri.
  TIKTOK_APP_KEY: z.string().min(1).optional(),
  TIKTOK_APP_SECRET: z.string().min(1).optional(),
  TIKTOK_SERVICE_ID: z.string().min(1).optional(),
  TIKTOK_REDIRECT_URL: z.url().optional(),
  TIKTOK_API_URL: z.url().default('https://open-api.tiktokglobalshop.com'),
  TIKTOK_AUTH_URL: z.url().default('https://auth.tiktok-shops.com'),
  // Ngân sách gọi TikTok mỗi ngày của cả app do mình đặt: TikTok không công bố hạn mức ngày, chỉ giới hạn tần suất động
  // theo app × gian hàng (docv2 Rate limits, tra 06/11/2026). Giữ để vòng việc nền lỗi không đốt request vô hạn.
  TIKTOK_DAILY_CALL_LIMIT: z.coerce.number().int().positive().default(20000),
  // Trần số đơn còn mở kéo về ở lượt sau thiết lập (#198): chỉ lấy N đơn đặt mới nhất, phần cũ hơn bỏ qua và báo ở
  // `Shop.setup.openOrdersSkipped`. Không đặt hoặc để trống là không giới hạn (Documents/25 §6.1); staging đặt để giữ hạn mức gọi sàn.
  OPEN_ORDER_PULL_MAX: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().positive().optional()),
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
  // Kho tệp qua API S3 (#212): Cloudflare R2, `https://<account id>.r2.cloudflarestorage.com`. Thiếu một trong
  // endpoint, cặp khoá, hai bucket thì `POST /files/uploads` trả 503 `storage_unavailable`.
  S3_ENDPOINT: z.url().optional(),
  // R2 không dùng region nhưng SDK bắt buộc có.
  S3_REGION: z.string().min(1).default('auto'),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  // Bucket công khai (ảnh sản phẩm, gắn tên miền riêng) và bucket riêng (đính kèm chứng từ, chỉ xem qua link ký sẵn).
  S3_PUBLIC_BUCKET: z.string().min(1).optional(),
  S3_PRIVATE_BUCKET: z.string().min(1).optional(),
  // Gốc URL công khai của bucket công khai, vd `https://files.letsrides.app`; link ảnh là `<gốc>/<storage_key>`.
  S3_PUBLIC_URL: z.url().optional(),
  // Tiền tố tên tệp theo môi trường (`dev`, `staging`) để máy dev và staging dùng chung bucket không lẫn tệp.
  S3_KEY_PREFIX: z
    .string()
    .regex(/^[a-z0-9-]+$/, 'Chỉ gồm chữ thường, số, gạch ngang')
    .default('dev'),
  // Trần tổng dung lượng tệp của mọi công ty, byte. Mặc định 8 GiB: gói miễn phí của R2 là 10 GB, chừa 20%.
  STORAGE_QUOTA_BYTES: z.coerce.number().int().positive().default(8 * 1024 ** 3),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    throw new Error(`Biến môi trường không hợp lệ:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export const env = loadEnv();
