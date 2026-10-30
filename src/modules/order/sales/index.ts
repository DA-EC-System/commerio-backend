// API công khai của module `sales`: đơn hàng, kênh nguồn, hồ sơ khách hàng.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../../shared/module.ts';
import { registerSalesOpenApi } from './api/openapi.ts';
import { salesRouter } from './api/routes.ts';
import { startSalesBackground } from './service/complete.ts';

export const salesModule: ModuleDefinition = {
  name: 'sales',
  router: salesRouter,
  openapi: registerSalesOpenApi,
  startBackground: startSalesBackground,
};

export {
  getOrderForPayment,
  type OrderForPayment,
  type OrderSource,
  type OrderStatus,
  type PaymentMethod,
} from './service/payment-boundary.ts';
export {
  findMarketplaceOrders,
  getOrderLines,
  getOrdersForFinance,
  type OrderForFinance,
  type OrderLineForInvoice,
} from './service/finance-boundary.ts';
export { getOrderChannels } from './service/daily-totals.ts';
// Nhận đơn sàn (#105): channel kéo đơn và push (#133) gọi trong `withCompany`.
export { ingestMarketplaceOrder, type PlatformOrder } from './service/ingest.ts';
export type { SalesContext } from './service/orders.ts';
export { completeDueOrdersOnce } from './service/complete.ts';
