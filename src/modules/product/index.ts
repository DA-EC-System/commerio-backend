// API công khai của module lớn `product` (Hàng hoá & kho: danh mục, tồn, mua hàng).
// Module lớn khác chỉ được import từ file này; module con trong cùng module lớn gọi nhau qua index.ts của module con.
import { type ModuleContext, type ModuleDefinition, withContext } from '../../shared/module.ts';
import { type BulkEditPorts, catalogModule, variantReadinessOf } from './catalog/index.ts';
import {
  applyReorderRule,
  inventoryModule,
  minQtyOf,
  reorderRulesOf,
  setIncomingSource,
  setSupplierReturnPort,
  stockArchiveBlockers,
  stockInUse,
} from './inventory/index.ts';
import {
  draftSupplierReturn,
  incomingOf,
  lastCostsOf,
  purchaseArchiveBlockers,
  purchaseDocumentNumbers,
  purchaseInUse,
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

/**
 * Độ hoàn thiện theo SKU (#204, Documents/25 §5.4) cho module khác: catalog tính, ngưỡng tồn lấy của inventory. Channel
 * dùng để chặn đẩy SKU chưa hoàn thiện (thay luật tạm `paused → sku_not_ready`). Gọi trong `withCompany`.
 */
export const variantReadiness = (variantIds: readonly string[]) => variantReadinessOf(variantIds, minQtyOf);

export const productModules: readonly ModuleDefinition[] = [
  // Sửa hàng loạt (#242); lý do chặn lưu trữ SKU phần kho, mua hàng và ngưỡng tồn cho nhãn (#204; phần đơn, sàn do
  // `src/wiring.ts` nối).
  withContext(catalogModule, (ctx) => ({
    ...ctx,
    bulkEdit: bulkEditPorts(ctx),
    stockArchiveBlockers,
    purchaseArchiveBlockers,
    minQtyOf,
    stockInUse,
    purchaseInUse,
  })),
  withContext(inventoryModule, (ctx) => ({ ...ctx, incomingOf, purchaseDocumentNumbers })),
  purchasingModule,
];
