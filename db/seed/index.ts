// npm run db:seed: nạp dữ liệu demo vào DATABASE_URL. Mật khẩu chung của tài khoản demo lấy từ SEED_PASSWORD.
// Điều phối ở scenarios.ts; không in mật khẩu hay token.
import { closeDb } from '#src/shared/db/client.ts';
import { defaultDemo } from './demo.ts';
import { parseSection, seedScenarios } from './scenarios.ts';

const password = process.env.SEED_PASSWORD;
if (!password || password.length < 8) {
  console.error('Cần SEED_PASSWORD (ít nhất 8 ký tự) cho tài khoản demo');
  process.exit(1);
}
try {
  const only = parseSection(process.argv.slice(2));
  const summary = await seedScenarios(defaultDemo(password), { only });
  console.log(JSON.stringify(summary, null, 2));
  console.log('Giới hạn: chưa seed tồn đầu kỳ, nhận/trả NCC, gian hàng, đơn bán và sổ tiền; xem db/seed/README.md.');
} catch (err) {
  // Lỗi truy vấn của Drizzle có cả tham số (email, băm mật khẩu) trong message: chỉ in lỗi gốc của PostgreSQL.
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  if (cause) console.error(`Lỗi cơ sở dữ liệu ${cause.code ?? ''}: ${cause.message}`);
  else console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await closeDb();
}
