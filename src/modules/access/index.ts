// API công khai của module `access`: vai trò có sẵn và tuỳ biến, quyền chi tiết. Mọi module kiểm quyền qua đây.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../shared/module.ts';

export const accessModule: ModuleDefinition = { name: 'access' };
