// API công khai của module lớn `product` (Hàng hoá & kho: danh mục, tồn, mua hàng).
// Module lớn khác chỉ được import từ file này; module con trong cùng module lớn gọi nhau qua index.ts của module con.
import { type ModuleContext, type ModuleDefinition, withContext } from '../../shared/module.ts';
import { type BulkEditPorts, catalogModule } from './catalog/index.ts';
import { applyReorderRule, inventoryModule, reorderRulesOf, setIncomingSource, setSupplierReturnPort } from './inventory/index.ts';
import {
  draftSupplierReturn,
  incomingOf,
  lastCostsOf,
  purchaseDocumentNumbers,
  purchasingModule,
  returnsFromStockDocuments,
} from './purchasing/index.ts';

export * from './catalog/index.ts';
export * from './inventory/index.ts';
export * from './purchasing/index.ts';

/**
 * Mỗi module con giữ tên và đường dẫn /api/v1/<tên> riêng; bảng nằm chung schema `product`. purchasing import inventory
 * (cấp số, giá vốn, ghi sổ), nên inventory nhận số đang về và số phiếu (thẻ kho) của purchasing qua `ctx` thay vì
 * import ngược (vòng).
 */
// Cảnh báo dưới ngưỡng cần đang về của purchasing cả khi ghi sổ ngoài request (inventory/service/thresholds.ts).
setIncomingSource(incomingOf);
// Phiếu kho sinh phiếu trả NCC nháp (kiểm hàng về, xuất huỷ bị từ chối) và hiện chúng ở `followUps` (#208).
setSupplierReturnPort({ draft: draftSupplierReturn, fromDocuments: returnsFromStockDocuments });

/**
 * Sửa hàng loạt của catalog (#242) cần giá nhập (purchasing), ngưỡng tồn (inventory) và số bán (sales, lớp trên, tiêm
 * qua `ctx.soldQtyOf` của src/wiring.ts); catalog (lớp dưới cùng) không import được các module đó.
 */
const bulkEditPorts = (ctx: ModuleContext & { soldQtyOf?: BulkEditPorts['soldQtyOf'] }): BulkEditPorts => ({
  lastCostsOf,
  reorderRulesOf,
  applyReorderRule,
  soldQtyOf: (ids, days) => (ctx.soldQtyOf ? ctx.soldQtyOf(ids, days) : Promise.resolve(new Map())),
});

export const productModules: readonly ModuleDefinition[] = [
  withContext(catalogModule, (ctx) => ({ ...ctx, bulkEdit: bulkEditPorts(ctx) })),
  withContext(inventoryModule, (ctx) => ({ ...ctx, incomingOf, purchaseDocumentNumbers })),
  purchasingModule,
];
