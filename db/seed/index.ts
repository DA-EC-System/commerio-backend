// npm run db:seed: nạp dữ liệu demo vào DATABASE_URL. Mật khẩu chung của tài khoản demo lấy từ SEED_PASSWORD.
// Logic nằm ở demo.ts (file này không được tsc kiểm, giữ thật ngắn).
import { closeDb } from '#src/shared/db/client.ts';
import { defaultDemo, seedDemo } from './demo.ts';

const password = process.env.SEED_PASSWORD;
if (!password || password.length < 8) {
  console.error('Cần SEED_PASSWORD (ít nhất 8 ký tự) cho tài khoản demo');
  process.exit(1);
}
try {
  const { companyId } = await seedDemo(defaultDemo(password));
  console.log(`Đã nạp dữ liệu demo, công ty ${companyId}`);
} catch (err) {
  // Lỗi truy vấn của Drizzle có cả tham số (email, băm mật khẩu) trong message: chỉ in lỗi gốc của PostgreSQL.
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  if (cause) console.error(`Lỗi cơ sở dữ liệu ${cause.code ?? ''}: ${cause.message}`);
  else console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await closeDb();
}
