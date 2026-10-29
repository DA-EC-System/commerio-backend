// API công khai của module lớn `product` (Hàng hoá & kho: danh mục, tồn, mua hàng).
// Module lớn khác chỉ được import từ file này; module con trong cùng module lớn gọi nhau qua index.ts của module con.
import { type ModuleDefinition, withContext } from '../../shared/module.ts';
import { catalogModule } from './catalog/index.ts';
import { inventoryModule } from './inventory/index.ts';
import { incomingOf, purchasingModule } from './purchasing/index.ts';

export * from './catalog/index.ts';
export * from './inventory/index.ts';
export * from './purchasing/index.ts';

/**
 * Mỗi module con giữ tên và đường dẫn /api/v1/<tên> riêng; bảng nằm chung schema `product`. purchasing import inventory
 * (cấp số, giá vốn, ghi sổ), nên inventory nhận số đang về của purchasing qua `ctx` thay vì import ngược (vòng).
 */
export const productModules: readonly ModuleDefinition[] = [
  catalogModule,
  withContext(inventoryModule, (ctx) => ({ ...ctx, incomingOf })),
  purchasingModule,
];
