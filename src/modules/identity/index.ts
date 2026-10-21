// API công khai của module `identity`: đăng ký, đăng nhập, refresh token, đổi mật khẩu.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../shared/module.ts';
import { registerIdentityOpenApi } from './api/openapi.ts';
import { identityRouter } from './api/routes.ts';

export const identityModule: ModuleDefinition = {
  name: 'identity',
  router: identityRouter,
  openapi: registerIdentityOpenApi,
};

export { loadCompanyAccess, register } from './service/auth-service.ts';
// Quản trị nền tảng đặt lại 2FA (#7 [D]): platform nhận qua `ctx` do src/wiring.ts tiêm.
export { platformAdminOf, resetTwoFactor } from './service/two-factor.ts';
// Seed dữ liệu demo (db/seed, #37) tạo tài khoản nhân viên và kiểm tài khoản đã có.
export { hashPassword, verifyPassword } from './service/passwords.ts';
