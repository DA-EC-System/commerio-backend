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
// Giá chuẩn là cột của SKU (Documents/19 D9).
export { type CatalogContext, standardPricesOf } from './service/standard-price.ts';
