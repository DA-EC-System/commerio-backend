// API công khai của module `purchasing`: nhà cung cấp, đơn mua, đợt nhận hàng.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../shared/module.ts';

export const purchasingModule: ModuleDefinition = { name: 'purchasing' };
