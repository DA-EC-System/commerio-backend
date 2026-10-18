import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  // Cổng nội bộ của api cho /metrics; worker và realtime dùng luôn cổng của mình làm cổng vận hành.
  API_OPS_PORT: z.coerce.number().int().positive().default(9464),
  WORKER_PORT: z.coerce.number().int().positive().default(3001),
  REALTIME_PORT: z.coerce.number().int().positive().default(3002),
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
