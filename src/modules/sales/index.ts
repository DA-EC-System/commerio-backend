// API công khai của module `sales`: đơn hàng, kênh nguồn, hồ sơ khách hàng.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../shared/module.ts';

export const salesModule: ModuleDefinition = { name: 'sales' };
