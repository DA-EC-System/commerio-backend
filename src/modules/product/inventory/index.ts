// API công khai của module `inventory`: các con số tồn, thẻ kho, phiếu kho, ngưỡng tồn. Nơi duy nhất đổi số tồn.
// Module khác chỉ được import từ file này. Hàm ghi sổ cho phiếu nhận, kiện, kiểm hàng về làm ở các issue vòng đời
// (Documents/21 mục 15–19).
import type { ModuleDefinition } from '../../../shared/module.ts';
import { registerInventoryOpenApi } from './api/openapi.ts';
import { inventoryRouter } from './api/routes.ts';

export const inventoryModule: ModuleDefinition = {
  name: 'inventory',
  router: inventoryRouter,
  openapi: registerInventoryOpenApi,
};

export { nextDocNumber, type StockSnapshot, stockOf } from './service/port.ts';
export type { IncomingLookup, InventoryContext } from './service/views.ts';
