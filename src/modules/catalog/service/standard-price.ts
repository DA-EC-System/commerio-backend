// Giá chuẩn trong chi tiết sản phẩm (V22). Chiều import là pricing → catalog (plan chuẩn bị A12), nên catalog
// không import pricing mà nhận hàm tra giá qua `ctx` do src/wiring.ts dựng (K4).
import type { Decimal } from 'decimal.js';
import { AppError } from '../../../shared/errors/app-error.ts';
import type { ModuleContext } from '../../../shared/module.ts';

export type StandardPriceLookup = (variantIds: readonly string[]) => Promise<Map<string, Decimal | null>>;

/** `ctx` mà router của catalog nhận. */
export interface CatalogContext extends ModuleContext {
  readonly standardPrices?: StandardPriceLookup;
}

/**
 * Giá chuẩn của từng biến thể, đủ mọi id đầu vào (chưa có giá thì `null`). Pricing chưa làm (`ctx` không có hàm
 * tra giá, hoặc hàm báo 501 `not_implemented` tới khi #14 xong) thì mọi giá `null`, không lỗi (A12). Lỗi khác ném ra.
 */
export async function standardPricesOf(
  ctx: CatalogContext,
  variantIds: readonly string[],
): Promise<Map<string, Decimal | null>> {
  let found = new Map<string, Decimal | null>();
  if (ctx.standardPrices) {
    try {
      found = await ctx.standardPrices(variantIds);
    } catch (err) {
      if (!(err instanceof AppError && err.code === 'not_implemented')) throw err;
    }
  }
  return new Map(variantIds.map((id) => [id, found.get(id) ?? null]));
}
