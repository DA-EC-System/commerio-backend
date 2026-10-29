// API công khai của module `inventory`: các con số tồn, thẻ kho, phiếu kho, ngưỡng tồn. Nơi duy nhất đổi số tồn.
// Module khác chỉ được import từ file này. Lõi ghi sổ `applyMoves` không export: module khác gọi hàm theo nghiệp vụ
// (`receiveGoods`, cổng theo kiện ở Documents/21 mục 11.1).
import type { ModuleDefinition } from '../../../shared/module.ts';
import { registerInventoryOpenApi } from './api/openapi.ts';
import { inventoryRouter } from './api/routes.ts';

export const inventoryModule: ModuleDefinition = {
  name: 'inventory',
  router: inventoryRouter,
  openapi: registerInventoryOpenApi,
};

export {
  availableOf,
  nextDocNumber,
  receiveBack,
  release,
  reserve,
  reverseShipment,
  ship,
  type StockLine,
  type StockSnapshot,
  stockOf,
} from './service/port.ts';
export { type ReceivedLine, receiveGoods } from './service/posting.ts';
export type { IncomingLookup, InventoryContext } from './service/views.ts';
