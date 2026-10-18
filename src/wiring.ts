// Nối các module lúc khởi động (plan chuẩn bị A1, K4): hàm một module cần từ module khác mà import thẳng
// sẽ ngược lớp hoặc thành vòng thì đi qua `ModuleContext`. Chỉ import `index.ts` của module.
import { loadCompanyAccess } from './modules/identity/index.ts';
import { createAuthorize } from './shared/auth/authorize.ts';
import type { ModuleContext } from './shared/module.ts';

export function createModuleContext(): ModuleContext {
  return { authorize: createAuthorize(loadCompanyAccess) };
}
