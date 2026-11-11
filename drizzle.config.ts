import { defineConfig } from 'drizzle-kit';

try {
  process.loadEnvFile();
} catch {
  // Không có .env thì dùng biến môi trường sẵn có (CI, container).
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/modules/*/*/repository/schema.ts',
  out: './db/migrations',
  // Tên file: <năm tháng ngày giờ phút giây UTC>_<tên>.sql, để hai nhánh cùng sinh migration không trùng tên (db/CLAUDE.md).
  migrations: { prefix: 'timestamp' },
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
