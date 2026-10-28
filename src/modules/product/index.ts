// API công khai của module lớn `product` (Hàng hoá & kho: danh mục, giá, tồn, mua hàng).
// Module lớn khác chỉ được import từ file này; module con trong cùng module lớn gọi nhau qua index.ts của module con.
import { type ModuleContext, type ModuleDefinition, withContext } from '../../shared/module.ts';
import { type CatalogContext, catalogModule } from './catalog/index.ts';
import { inventoryModule } from './inventory/index.ts';
import { getStandardPrices, pricingModule } from './pricing/index.ts';
import { purchasingModule } from './purchasing/index.ts';

export * from './catalog/index.ts';
export * from './pricing/index.ts';
export * from './inventory/index.ts';
export * from './purchasing/index.ts';

/** `ctx` của catalog kèm giá chuẩn của pricing (V22, A12). pricing gắn giá vào biến thể của catalog, nên catalog không import pricing. */
export function catalogContext<C extends ModuleContext>(ctx: C): C & Required<Pick<CatalogContext, 'standardPrices'>> {
  return { ...ctx, standardPrices: getStandardPrices };
}

/** Mỗi module con giữ tên, schema và đường dẫn /api/v1/<tên> riêng. */
export const productModules: readonly ModuleDefinition[] = [
  withContext(catalogModule, catalogContext),
  pricingModule,
  inventoryModule,
  purchasingModule,
];
