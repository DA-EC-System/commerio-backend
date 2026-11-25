// API công khai của module lớn `order` (Đơn hàng: đơn, khách hàng, vòng đời giao).
// Module lớn khác chỉ được import từ file này; module con trong cùng module lớn gọi nhau qua index.ts của module con.
import { type ModuleDefinition, withContext } from '../../shared/module.ts';
import {
  applyLineSkus, getOrder, lockOrderLines, nextPackageCode, orderRefsOf, returnsModule, salesModule, settleCancelledOrder,
} from './sales/index.ts';
import { type FulfillmentContext, fulfillmentModule } from './fulfillment/index.ts';

export * from './sales/index.ts';
export * from './fulfillment/index.ts';

/** Mỗi module con giữ tên, schema và đường dẫn /api/v1/<tên> riêng. */
export const orderModules: readonly ModuleDefinition[] = [
  salesModule,
  returnsModule,
  // Route kiện cần thông tin đơn của sales; fulfillment import sales sẽ thành vòng (src/modules/CLAUDE.md). Tách kiện
  // (#205) trả `Order` của sales và xin mã kiện từ bộ đếm của sales; mở kiện huỷ cả kiện thì khép đơn đang huỷ; mở kiện
  // đơn sàn áp lại ghép SKU thì khoá, ghi dòng đơn (#237 PR 2).
  withContext(fulfillmentModule, (ctx): FulfillmentContext => ({
    ...ctx, orderRefsOf, orderViewOf: (orderId) => getOrder(ctx, orderId), nextPackageCode, settleCancelledOrder, lockOrderLines, applyLineSkus,
  })),
];
