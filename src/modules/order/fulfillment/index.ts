// API công khai của module `fulfillment`: kiện (giữ hàng, đóng gói, bàn giao, giao, hoàn), hàng trả không khớp.
// Module khác chỉ được import từ file này. Máy trạng thái kiện làm ở issue vòng đời D2 (Documents/21 mục 19.2).
import { registerConsumer, workQueue } from '../../core/index.ts';
import type { ModuleDefinition } from '../../../shared/module.ts';
import { registerFulfillmentOpenApi } from './api/openapi.ts';
import { fulfillmentRouter } from './api/routes.ts';
import { allocationJobs, onAllocationJob, onStockChanged } from './service/allocation.ts';
import type { FulfillmentContext } from './service/packages.ts';

export const fulfillmentModule: ModuleDefinition = {
  name: 'fulfillment',
  router: fulfillmentRouter,
  openapi: registerFulfillmentOpenApi,
  async startBackground(ctx) {
    // Phân hàng cho kiện (#199 phần b): tồn đổi thì chạy một lượt cho SKU đó; kiện huỷ, ghép SKU, dỡ kiện xếp việc nền.
    const allocation = ctx as FulfillmentContext;
    registerConsumer('inventory.stock_changed', onStockChanged(allocation), { consumer: 'fulfillment-allocation' });
    await workQueue(allocationJobs, onAllocationJob(allocation));
    // pg-boss dừng chung ở platform (dừng nhận việc, chờ việc đang chạy).
    return async () => {};
  },
};

export { getOrderCogs } from './service/cogs.ts';
export {
  arrowAction,
  holdsStock,
  isHandedOver,
  isSealed,
  isStopped,
  packageMachine,
  platformUpdate,
  type PackageAction,
  type PackageStatus,
} from './domain/package.ts';
export {
  type CancelKind,
  type PackageEvent,
  type PlatformLineStatus,
  type PlatformPackageLine,
  syncPlatformPackages,
} from './service/platform-packages.ts';
export { findPackagesOfOrders, type PackageViewRow } from './repository/packages.ts';
export { PackageSummary, ShopRef, StatusChange } from './api/schemas.ts';
export { type PackageOrderLineRef, type PackageOrderRef, toPackageSummary } from './service/views.ts';
export type { FulfillmentContext } from './service/packages.ts';
// Hàm bù cho #198 (phiếu kiểm kê đầu kỳ ghi sổ) và dòng ghép SKU muộn cho #237; chạy trong `withCompany` của bên gọi.
export { settleDeferredHandovers, shipLateMappedLines } from './service/handover-stock.ts';
// Xếp lượt phân hàng cho #237 (ghép xong SKU), #239 (dỡ kiện về kệ); chạy trong `withCompany` của bên gọi.
export { requestAllocation } from './service/allocation.ts';
// Cho channel (#198 phần 2): gọi trong giao dịch thoát chờ kiểm kê, sau khi đặt `openingStocktake = null` (spec 199b §5.5).
export { settleOpeningStocktake } from './service/allocation.ts';
// Cho finance (E139, spec 199c §5.6): trạng thái kiện theo id, chạy trong `withCompany` của bên gọi.
export { packageStatusOf, type PackageStatusInfo } from './service/delivery.ts';
