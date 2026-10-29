// Giá chuẩn trong chi tiết sản phẩm là cột `standard_price` của SKU (Documents/19 D9: bỏ module con pricing).
import { Decimal } from 'decimal.js';
import type { ModuleContext } from '../../../../shared/module.ts';
import { standardPricesByVariant } from '../repository/variants.ts';

/** `ctx` mà router của catalog nhận. */
export type CatalogContext = ModuleContext;

/** Giá chuẩn của từng biến thể, đủ mọi id đầu vào (chưa có giá thì `null`). Gọi trong `withCompany`. */
export async function standardPricesOf(
  _ctx: CatalogContext,
  variantIds: readonly string[],
): Promise<Map<string, Decimal | null>> {
  const rows = variantIds.length ? await standardPricesByVariant(variantIds) : [];
  const found = new Map(rows.map((r) => [r.id, r.standardPrice === null ? null : new Decimal(r.standardPrice)]));
  return new Map(variantIds.map((id) => [id, found.get(id) ?? null]));
}
