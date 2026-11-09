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
