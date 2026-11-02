// npm run platform-admin -- <email> [--revoke]: cấp hay gỡ quyền quản trị nền tảng trên DATABASE_URL (#152).
// Tài khoản chưa có thì tạo, mật khẩu lấy từ PLATFORM_ADMIN_PASSWORD, họ tên từ PLATFORM_ADMIN_NAME (tuỳ chọn).
// Logic ở seed/platform-admin.ts (file này không được tsc kiểm, giữ thật ngắn).
import { closeDb } from '#src/shared/db/client.ts';
import { grantPlatformAdmin, revokePlatformAdmin } from './seed/platform-admin.ts';

const args = process.argv.slice(2);
const email = args.find((a) => !a.startsWith('--'));
if (!email) {
  console.error('Dùng: npm run platform-admin -- <email> [--revoke]');
  process.exit(1);
}
try {
  const result = args.includes('--revoke')
    ? await revokePlatformAdmin(email)
    : await grantPlatformAdmin({
        email,
        fullName: process.env.PLATFORM_ADMIN_NAME,
        password: process.env.PLATFORM_ADMIN_PASSWORD,
      });
  console.log(`${email}: ${result}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await closeDb();
}
