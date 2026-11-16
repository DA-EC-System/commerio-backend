// API công khai của module `inventory`: các con số tồn, thẻ kho, phiếu kho, ngưỡng tồn. Nơi duy nhất đổi số tồn.
// Module khác chỉ được import từ file này. Lõi ghi sổ `applyChange` không export: module khác gọi hàm theo nghiệp vụ
// (`receiveGoods`, cổng theo kiện ở Documents/21 mục 11.1).
import type { ModuleDefinition } from '../../../shared/module.ts';
import { registerInventoryOpenApi } from './api/openapi.ts';
import { inventoryRouter } from './api/routes.ts';
import { startInventoryConsumers } from './service/background.ts';

export const inventoryModule: ModuleDefinition = {
  name: 'inventory',
  router: inventoryRouter,
  openapi: registerInventoryOpenApi,
  // Nghe đổi trạng thái kinh doanh SKU để xét lại ngưỡng (#204).
  async startBackground() {
    startInventoryConsumers();
    return async () => {};
  },
};

export {
  availableOf,
  type DocumentRef,
  nextDocNumber,
  type ReceiveBackMeta,
  type ReturnedLine,
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
export { InsufficientStock, moveSupplierReturn, type ReceivedLine, receiveGoods, type ReturnLine } from './service/posting.ts';
// Số phiếu kho cho chứng từ của purchasing (nguồn, phiếu sinh tiếp của phiếu trả NCC, #210).
export { docRefsOf as stockDocumentRefs, docsFromSource as stockDocumentsFrom } from './repository/documents.ts';
// Phiếu kho có duyệt (#208): xuất huỷ chờ xử lý cho phiếu trả NCC bị huỷ (#210), kiểm kê đầu kỳ cho channel (#245).
export { createOpeningStocktake, createQuarantineWriteOff } from './service/documents.ts';
// Trạng thái phiếu kiểm kê đầu kỳ cho channel (#198, #245).
export { docStatusesOf as stockDocumentStatusOf } from './repository/documents.ts';
export { setSupplierReturnPort, type SupplierReturnPort } from './service/document-views.ts';
export { recheckThresholds, setIncomingSource } from './service/thresholds.ts';
// Lý do chặn lưu trữ SKU phần kho cho catalog (#204); `product/index.ts` nối vào `ctx` của catalog.
export { stockArchiveBlockers } from './service/archive-blockers.ts';
// Ngưỡng tồn cho sửa hàng loạt của catalog (#242), trong giao dịch của bên gọi.
export { applyReorderRule, reorderRulesOf } from './service/stock.ts';
export type { IncomingLookup, InventoryContext } from './service/views.ts';
