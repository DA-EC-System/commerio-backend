// API công khai của module `identity`: đăng ký, đăng nhập, refresh token, đổi mật khẩu.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../shared/module.ts';
import { registerIdentityOpenApi } from './api/openapi.ts';
import { identityRouter } from './api/routes.ts';

export const identityModule: ModuleDefinition = {
  name: 'identity',
  router: identityRouter(),
  openapi: registerIdentityOpenApi,
};
