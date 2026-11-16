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
// Sửa hàng loạt có gợi ý (#242): dữ liệu của purchasing, inventory, sales vào qua cổng này (src/modules/product/index.ts).
export type { BulkEditContext, BulkEditPorts } from './service/bulk-edit.ts';
// Sản phẩm mới từ đề nghị nhập (#108): purchasing kiểm khi lập, tạo khi duyệt, trong giao dịch của purchasing.
export {
  categoryNames,
  createPurchaseProducts,
  type NewProductErrors,
  type NewProductItem,
  validateNewProducts,
} from './service/purchase-products.ts';
// Giá chuẩn và giá muốn bán là cột của SKU (Documents/19 D9); channel đọc giá muốn bán cho bộ lọc giá (#225).
export { type CatalogContext, standardPricesOf, targetNetPricesOf } from './service/standard-price.ts';
// Link ảnh sản phẩm cho channel (ảnh đại diện của listing, ảnh đẩy lên sàn; #303).
export { productImageUrls } from './service/product-images.ts';
