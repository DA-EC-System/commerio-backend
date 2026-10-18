// API công khai của module `payment`: mã thanh toán, giao dịch, trạng thái thanh toán của đơn, cấu hình cổng.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../shared/module.ts';
import { registerPaymentOpenApi } from './api/openapi.ts';
import { paymentRouter } from './api/routes.ts';

export const paymentModule: ModuleDefinition = {
  name: 'payment',
  router: paymentRouter,
  openapi: registerPaymentOpenApi,
};
