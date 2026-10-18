// API công khai của module `sales`: đơn hàng, kênh nguồn, hồ sơ khách hàng.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../shared/module.ts';
import { registerSalesOpenApi } from './api/openapi.ts';
import { salesRouter } from './api/routes.ts';

export const salesModule: ModuleDefinition = {
  name: 'sales',
  router: salesRouter,
  openapi: registerSalesOpenApi,
};

export {
  getOrderForPayment,
  type OrderForPayment,
  type OrderSource,
  type OrderStatus,
  type PaymentMethod,
} from './service/payment-boundary.ts';
export {
  getOrderLines,
  getOrdersForFinance,
  type OrderForFinance,
  type OrderLineForInvoice,
} from './service/finance-boundary.ts';
export { getOrderChannels } from './service/daily-totals.ts';
