// API công khai của module `identity`: đăng ký, đăng nhập, refresh token, đổi mật khẩu.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../../shared/module.ts';
import { registerIdentityOpenApi } from './api/openapi.ts';
import { identityRouter } from './api/routes.ts';
import { startIdentityBackground } from './service/registration.ts';

export const identityModule: ModuleDefinition = {
  name: 'identity',
  router: identityRouter,
  openapi: registerIdentityOpenApi,
  startBackground: startIdentityBackground,
};

export { type IdentityContext, loadCompanyAccess, register, type SeedCompanyDefaults } from './service/auth-service.ts';
// Test và seed: xử lý việc gửi thư đăng ký, dọn lần đăng ký cũ (#459).
export { handleRegistrationMail, runRegistrationPurge } from './service/registration.ts';
// Seed dữ liệu demo (db/seed, #37) tạo tài khoản nhân viên và kiểm tài khoản đã có.
export { hashPassword, verifyPassword } from './service/passwords.ts';
