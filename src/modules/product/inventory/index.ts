// API công khai của module `inventory`: các con số tồn, thẻ kho, phiếu kho, ngưỡng tồn. Nơi duy nhất đổi số tồn.
// Module khác chỉ được import từ file này. Lõi ghi sổ `applyChange` không export: module khác gọi hàm theo nghiệp vụ
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
  type DocumentRef,
  nextDocNumber,
  receiveBack,
  release,
  reserve,
  reverseShipment,
  type ShipLine,
  type ShipOptions,
  ship,
  type StockLine,
  type StockSnapshot,
  stockOf,
} from './service/port.ts';
export { type ReceivedLine, receiveGoods } from './service/posting.ts';
// Phiếu kho có duyệt (#208): xuất huỷ chờ xử lý cho phiếu trả NCC bị huỷ (#210).
export { createQuarantineWriteOff } from './service/documents.ts';
export { setSupplierReturnPort, type SupplierReturnPort } from './service/document-views.ts';
export { recheckThresholds, setIncomingSource } from './service/thresholds.ts';
export type { IncomingLookup, InventoryContext } from './service/views.ts';
