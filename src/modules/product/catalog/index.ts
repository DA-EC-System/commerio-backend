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
// Giá chuẩn đi vào catalog qua ctx (A12): catalog không import pricing, src/modules/product/index.ts tiêm `standardPrices`.
export { type CatalogContext, type StandardPriceLookup, standardPricesOf } from './service/standard-price.ts';
