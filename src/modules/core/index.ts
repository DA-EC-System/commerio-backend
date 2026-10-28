// API công khai của module lớn `core` (Nền tảng: công ty, đăng nhập, nhân viên, phân quyền, nhật ký, tệp, thông báo).
// Module lớn khác chỉ được import từ file này; module con trong cùng module lớn gọi nhau qua index.ts của module con.
import type { ModuleDefinition } from '../../shared/module.ts';
import { platformModule } from './platform/index.ts';
import { identityModule } from './identity/index.ts';
import { staffModule } from './staff/index.ts';
import { accessModule } from './access/index.ts';
import { auditModule } from './audit/index.ts';
import { filesModule } from './files/index.ts';
import { notificationModule } from './notification/index.ts';

export * from './platform/index.ts';
export * from './identity/index.ts';
export * from './staff/index.ts';
export * from './access/index.ts';
export * from './audit/index.ts';
export * from './files/index.ts';
export * from './notification/index.ts';

/** Mỗi module con giữ tên, schema và đường dẫn /api/v1/<tên> riêng. */
export const coreModules: readonly ModuleDefinition[] = [platformModule, identityModule, staffModule, accessModule, auditModule, filesModule, notificationModule];
