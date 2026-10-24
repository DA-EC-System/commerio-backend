// API công khai của module `pricing`: bảng giá chuẩn, giá theo kênh.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../../shared/module.ts';
import { registerPricingOpenApi } from './api/openapi.ts';
import { pricingRouter } from './api/routes.ts';

export const pricingModule: ModuleDefinition = {
  name: 'pricing',
  router: pricingRouter,
  openapi: registerPricingOpenApi,
};

// getStandardPrices: catalog nhận qua src/modules/product/index.ts (V22, A12); createStandardPricelist: identity gọi khi đăng ký (V13).
export { createStandardPricelist, getStandardPrices } from './service/standard-prices.ts';
