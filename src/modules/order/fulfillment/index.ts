// API công khai của module `fulfillment`: State Machine duyệt đơn, lịch sử chuyển trạng thái, lô nhặt/đóng gói.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../../shared/module.ts';
import { registerFulfillmentOpenApi } from './api/openapi.ts';
import { fulfillmentRouter } from './api/routes.ts';

export const fulfillmentModule: ModuleDefinition = {
  name: 'fulfillment',
  router: fulfillmentRouter,
  openapi: registerFulfillmentOpenApi,
};
