// API công khai của module `auth`: mật khẩu băm, liên kết Google, refresh token.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../shared/module.ts';

export const authModule: ModuleDefinition = { name: 'auth' };
