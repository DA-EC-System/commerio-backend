// API công khai của module `fulfillment`: kiện (giữ hàng, đóng gói, bàn giao, giao, hoàn), hàng trả không khớp.
// Module khác chỉ được import từ file này. Máy trạng thái kiện làm ở issue vòng đời D2 (Documents/21 mục 19.2).
import type { ModuleDefinition } from '../../../shared/module.ts';
import { registerFulfillmentOpenApi } from './api/openapi.ts';
import { fulfillmentRouter } from './api/routes.ts';

export const fulfillmentModule: ModuleDefinition = {
  name: 'fulfillment',
  router: fulfillmentRouter,
  openapi: registerFulfillmentOpenApi,
};

export { getOrderCogs } from './service/cogs.ts';
