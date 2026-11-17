// Giá hiệu lực của listing trên trang listing (#225; Documents/21 §18.6.7, 25 §6.2). Gọi trong `withCompany`.
// Thứ tự: giá ghi đè tay > lần tính đã xác nhận (`shop`) > giá chuẩn. Thực nhận và cờ Dưới giá thấp nhất tính lúc đọc từ
// giá đang bán với phí, thuế, giá vốn hiện tại, nên đổi giá vốn không cần ghi gì thêm. Không trả giá vốn, giá thấp nhất.
import type { Decimal } from 'decimal.js';
import type { PriceFilterResult } from '../domain/price-filter.ts';
import type { ListingRow } from '../repository/listings.ts';
import { findCalculations, pendingCalculations } from '../repository/price-calculations.ts';
import { evaluatePrices } from './price-inputs.ts';

export interface ListingPrice {
  price: number | null;
  priceSource: 'standard' | 'shop' | 'override' | null;
  shopPrice: number | null;
  pendingPrice: number | null;
  configVersionId: string | null;
  netReceived: number | null;
  belowFloor: boolean | null;
  feeWarning: 'over_50' | null;
}

/** Thực nhận, cờ, cảnh báo phí từ kết quả bước 5; tổng phí từ 100% trở lên thì thực nhận ≤ 0, coi như dưới giá thấp nhất. */
export const floorView = (r: PriceFilterResult | undefined) =>
  !r
    ? { netReceived: null, belowFloor: null, feeWarning: null }
    : r.ok
      ? { netReceived: Number(r.net), belowFloor: r.belowFloor, feeWarning: r.feeWarning }
      : { netReceived: null, belowFloor: true, feeWarning: 'over_50' as const };

/** Giá của từng biến thể trên gian hàng; `rows` là listing hiện hành (biến thể chưa có listing dùng giá chuẩn). */
export async function listingPrices(
  shopId: string,
  variantIds: readonly string[],
  rows: readonly ListingRow[],
  standard: ReadonlyMap<string, Decimal | null>,
): Promise<Map<string, ListingPrice>> {
  const listed = rows.filter((l) => l.variantId && l.status !== 'delisted');
  const byVariant = new Map(listed.map((l) => [l.variantId!, l]));
  const [pending, confirmed] = await Promise.all([
    pendingCalculations(shopId, [...byVariant.keys()]),
    findCalculations(listed.flatMap((l) => (l.priceCalcId ? [l.priceCalcId] : []))),
  ]);
  type Own = Pick<ListingPrice, 'price' | 'priceSource' | 'shopPrice'>;
  const own = new Map(
    variantIds.map((id): [string, Own] => {
      const std = standard.get(id) ?? null;
      const base: Own = { price: std && std.toNumber(), priceSource: std ? 'standard' : null, shopPrice: null };
      const l = byVariant.get(id);
      if (!l) return [id, base];
      const calc = l.priceCalcId ? confirmed.get(l.priceCalcId) : undefined;
      const shopPrice = calc && ['confirmed', 'pushed'].includes(calc.status) ? Number(calc.roundedPrice) : null;
      if (l.manualPrice !== null) return [id, { price: Number(l.manualPrice), priceSource: 'override', shopPrice }];
      return [id, shopPrice !== null ? { price: shopPrice, priceSource: 'shop', shopPrice } : base];
    }),
  );
  const listedPrices = new Map(
    [...byVariant.keys()].flatMap((id) => {
      const p = own.get(id)?.price;
      return p == null ? [] : [[id, String(p)] as const];
    }),
  );
  const { hasFee, results } = await evaluatePrices(shopId, listedPrices);
  return new Map(
    variantIds.map((id): [string, ListingPrice] => {
      const next = pending.get(id);
      return [
        id,
        {
          ...own.get(id)!,
          pendingPrice: next ? Number(next.roundedPrice) : null,
          configVersionId: next?.feeVersionId ?? null,
          ...floorView(hasFee ? results.get(id) : undefined),
        },
      ];
    }),
  );
}
