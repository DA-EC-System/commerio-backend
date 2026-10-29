// API công khai của module lớn `core` (Nền tảng: công ty, đăng nhập, nhân viên, phân quyền, nhật ký, tệp, thông báo).
// Module lớn khác chỉ được import từ file này; module con trong cùng module lớn gọi nhau qua index.ts của module con.
import { type ModuleContext, type ModuleDefinition, withContext } from '../../shared/module.ts';
import { platformModule } from './platform/index.ts';
import { identityModule } from './identity/index.ts';
import { findAccountById, findAccountSummaries, staffModule } from './staff/index.ts';
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

/**
 * `ctx` của `platform` và `audit` kèm hàm của `staff` (#152): `staff` import cả hai nên không import ngược được.
 * Họ tên, email người thao tác; cờ quản trị nền tảng đọc từ DB mỗi request như `authorize`.
 */
function staffContext<C extends ModuleContext>(ctx: C) {
  return {
    ...ctx,
    accountSummaries: findAccountSummaries,
    isPlatformAdmin: async (accountId: string) => (await findAccountById(accountId))?.isPlatformAdmin ?? false,
  };
}

/** Mỗi module con giữ tên, schema và đường dẫn /api/v1/<tên> riêng. */
export const coreModules: readonly ModuleDefinition[] = [
  withContext(platformModule, staffContext),
  identityModule,
  staffModule,
  accessModule,
  withContext(auditModule, staffContext),
  filesModule,
  notificationModule,
];
