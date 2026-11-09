// API công khai của module lớn `order` (Đơn hàng: đơn, khách hàng, vòng đời giao).
// Module lớn khác chỉ được import từ file này; module con trong cùng module lớn gọi nhau qua index.ts của module con.
import { type ModuleDefinition, withContext } from '../../shared/module.ts';
import { orderRefsOf, salesModule } from './sales/index.ts';
import { type FulfillmentContext, fulfillmentModule } from './fulfillment/index.ts';

export * from './sales/index.ts';
export * from './fulfillment/index.ts';

/** Mỗi module con giữ tên, schema và đường dẫn /api/v1/<tên> riêng. */
export const orderModules: readonly ModuleDefinition[] = [
  salesModule,
  // Route kiện cần thông tin đơn của sales; fulfillment import sales sẽ thành vòng (src/modules/CLAUDE.md).
  withContext(fulfillmentModule, (ctx): FulfillmentContext => ({ ...ctx, orderRefsOf })),
];
