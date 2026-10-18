// API công khai của module `inventory`: tồn, giữ hàng, phiếu nhập/xuất/nhập hoàn, giá vốn, ngưỡng tồn. Nơi duy nhất đổi số tồn.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../shared/module.ts';
import { registerInventoryOpenApi } from './api/openapi.ts';
import { inventoryRouter } from './api/routes.ts';

export const inventoryModule: ModuleDefinition = {
  name: 'inventory',
  router: inventoryRouter,
  openapi: registerInventoryOpenApi,
};
