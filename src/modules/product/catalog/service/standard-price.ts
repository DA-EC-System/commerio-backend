// Giá của SKU là cột của `product_variants` (Documents/19 D9: bỏ module con pricing): giá chuẩn `standard_price` và
// giá muốn bán `target_net_price` (số muốn thực nhận, Documents/25 §6.2; channel đọc cho bộ lọc giá, #225).
import { Decimal } from 'decimal.js';
import type { ModuleContext } from '../../../../shared/module.ts';
import { variantPrices } from '../repository/variants.ts';

/** `ctx` mà router của catalog nhận. */
export type CatalogContext = ModuleContext;

type PriceColumn = 'standardPrice' | 'targetNetPrice';

/** Giá theo một cột, đủ mọi id đầu vào (chưa có giá hoặc id không thấy thì `null`). Gọi trong `withCompany`. */
async function pricesOf(variantIds: readonly string[], column: PriceColumn): Promise<Map<string, Decimal | null>> {
  const rows = variantIds.length ? await variantPrices(variantIds) : [];
  const found = new Map(rows.map((r) => [r.id, r[column] === null ? null : new Decimal(r[column])]));
  return new Map(variantIds.map((id) => [id, found.get(id) ?? null]));
}

/** Giá chuẩn của từng biến thể, đủ mọi id đầu vào (chưa có giá thì `null`). Gọi trong `withCompany`. */
export async function standardPricesOf(
  _ctx: CatalogContext,
  variantIds: readonly string[],
): Promise<Map<string, Decimal | null>> {
  return pricesOf(variantIds, 'standardPrice');
}

/** Giá muốn bán của từng biến thể, cùng luật với `standardPricesOf` (#204, spec D2). Gọi trong `withCompany`. */
export async function targetNetPricesOf(variantIds: readonly string[]): Promise<Map<string, Decimal | null>> {
  return pricesOf(variantIds, 'targetNetPrice');
}
