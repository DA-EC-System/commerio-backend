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
  release,
  reserve,
  reverseShipment,
  ship,
  type StockLine,
  type StockSnapshot,
  stockOf,
} from './service/port.ts';
export { InsufficientStock, moveSupplierReturn, type ReceivedLine, receiveGoods, type ReturnLine } from './service/posting.ts';
// Số phiếu kho cho chứng từ của purchasing (nguồn, phiếu sinh tiếp của phiếu trả NCC, #210).
export { docRefsOf as stockDocumentRefs, docsFromSource as stockDocumentsFrom } from './repository/documents.ts';
// Phiếu kho có duyệt (#208): kiểm hàng về do module khác lập, xuất huỷ chờ xử lý cho phiếu trả NCC bị huỷ (#210).
export { createOpeningStocktake, createQuarantineWriteOff, receiveBack } from './service/documents.ts';
// Trạng thái phiếu kiểm kê đầu kỳ cho channel (#198, #245).
export { docStatusesOf as stockDocumentStatusOf } from './repository/documents.ts';
export { setSupplierReturnPort, type SupplierReturnPort } from './service/document-views.ts';
export { recheckThresholds, setIncomingSource } from './service/thresholds.ts';
export type { IncomingLookup, InventoryContext } from './service/views.ts';
