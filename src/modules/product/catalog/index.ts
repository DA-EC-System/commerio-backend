// API công khai của module `catalog`: danh mục, thuộc tính, sản phẩm, biến thể, quy tắc SKU.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../../shared/module.ts';
import { registerCatalogOpenApi } from './api/openapi.ts';
import { catalogRouter } from './api/routes.ts';

export const catalogModule: ModuleDefinition = {
  name: 'catalog',
  router: catalogRouter,
  openapi: registerCatalogOpenApi,
};

export { getVariants, type VariantSummary } from './service/variants.ts';
// Sản phẩm mới từ đề nghị nhập (#108): purchasing kiểm khi lập, tạo khi duyệt, trong giao dịch của purchasing.
export {
  categoryNames,
  createPurchaseProducts,
  type NewProductErrors,
  type NewProductItem,
  validateNewProducts,
} from './service/purchase-products.ts';
// Giá chuẩn và giá muốn bán là cột của SKU (Documents/19 D9); channel đọc giá muốn bán cho bộ lọc giá (#225).
export { standardPricesOf, targetNetPricesOf } from './service/standard-price.ts';
// `ctx` của catalog: nguồn lý do chặn lưu trữ SKU do `product/index.ts` và `src/wiring.ts` nối (#204).
export type { ArchiveBlockerSource, CatalogContext } from './service/usage.ts';
// Link ảnh sản phẩm cho channel (ảnh đại diện của listing, ảnh đẩy lên sàn; #303).
export { productImageUrls } from './service/product-images.ts';
// Hệ thống tự khôi phục SKU lưu trữ khi có hàng vào; inventory gọi trong `applyChange` (#204).
export { restoreArchivedBySystem } from './service/business-status.ts';
