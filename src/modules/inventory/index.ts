// API công khai của module `inventory`: tồn, giữ hàng, phiếu nhập/xuất/nhập hoàn, giá vốn, ngưỡng tồn. Nơi duy nhất đổi số tồn.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../shared/module.ts';

export const inventoryModule: ModuleDefinition = { name: 'inventory' };
