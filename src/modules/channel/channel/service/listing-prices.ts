// Giá hiệu lực của listing trên trang listing (#225; Documents/21 §18.6.7, 25 §6.2). Gọi trong `withCompany`.
// Thứ tự: giá ghi đè tay > lần tính đã xác nhận (`shop`) > giá chuẩn. Thực nhận và cờ Dưới giá thấp nhất tính lúc đọc từ
// giá đang bán với phí, thuế, giá vốn hiện tại, nên đổi giá vốn không cần ghi gì thêm. Không trả giá vốn, giá thấp nhất.
import type { Decimal } from 'decimal.js';
import type { PriceFilterResult } from '../domain/price-filter.ts';
import type { ListingRow } from '../repository/listings.ts';
import { findCalculations, pendingCalculations } from '../repository/price-calculations.ts';
import { evaluatePrices } from './price-inputs.ts';
import { firstPushCalculations } from './repricing.ts';

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

type Own = Pick<ListingPrice, 'price' | 'priceSource' | 'shopPrice'>;

/**
 * Giá đang bán của từng biến thể (ghi đè tay > giá theo gian hàng đã xác nhận > giá chuẩn), giá lượt đồng bộ đẩy lên sàn
 * (#225 phần 2). `rows` là listing hiện hành; biến thể chưa có listing dùng giá chuẩn.
 */
export async function currentPrices(
  variantIds: readonly string[],
  rows: readonly ListingRow[],
  standard: ReadonlyMap<string, Decimal | null>,
): Promise<Map<string, Own>> {
  const byVariant = new Map(rows.filter((l) => l.variantId && l.status !== 'delisted').map((l) => [l.variantId!, l]));
  const confirmed = await findCalculations([...byVariant.values()].flatMap((l) => (l.priceCalcId ? [l.priceCalcId] : [])));
  return new Map(
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
}

/**
 * Lần đẩy kế của biến thể sẽ tính giá bộ lọc (cùng điều kiện `firstPush` của `pushListings`) mà lượt đồng bộ không đẩy giá
 * cho nó: chưa có listing, listing đã gỡ, hoặc `push_failed` chưa có giá ghi đè hay lần tính. `rejected`, `platform_hold`
 * còn mã sàn nên lượt đồng bộ vẫn đẩy giá đang bán, giữ giá đó.
 */
const nextPushFiltered = (l: ListingRow | undefined) =>
  !l || l.status === 'delisted' || (l.status === 'push_failed' && l.manualPrice === null && l.priceCalcId === null);

/**
 * Giá của từng biến thể trên gian hàng kèm giá chờ, thực nhận, cờ (trang listing). Biến thể chưa lên sàn hiện giá bộ lọc
 * mà lần đẩy sẽ đăng (`firstPushCalculations`, cùng hàm với lúc đẩy nên số hiện ra bằng số gửi lên sàn); không tính được
 * (gian hàng chưa có phí, SKU chưa có giá muốn bán) thì giá chuẩn (bình luận LZ-KB-B01 của #225).
 */
export async function listingPrices(
  shopId: string,
  variantIds: readonly string[],
  rows: readonly ListingRow[],
  standard: ReadonlyMap<string, Decimal | null>,
): Promise<Map<string, ListingPrice>> {
  const byVariant = new Map(rows.filter((l) => l.variantId && l.status !== 'delisted').map((l) => [l.variantId!, l]));
  const [pending, own, preview] = await Promise.all([
    pendingCalculations(shopId, [...byVariant.keys()]),
    currentPrices(variantIds, rows, standard),
    firstPushCalculations(
      shopId,
      variantIds.filter((id) => nextPushFiltered(byVariant.get(id))),
    ),
  ]);
  for (const [id, calc] of preview) {
    const price = Number(calc.roundedPrice);
    own.set(id, { price, priceSource: 'shop', shopPrice: price });
  }
  const listedPrices = new Map(
    [...new Set([...byVariant.keys(), ...preview.keys()])].flatMap((id) => {
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
