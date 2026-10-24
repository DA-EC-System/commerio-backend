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
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
