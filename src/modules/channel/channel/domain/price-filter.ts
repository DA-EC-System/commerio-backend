// Bộ lọc giá theo gian hàng (#225; Documents/25 §6.2). Thuần: nhận giá muốn bán (thực nhận mỗi món), phí, thuế của
// gian hàng, giá vốn và lãi tối thiểu; trả giá niêm yết, thực nhận và cờ Dưới giá thấp nhất. Bước 3 (điều chỉnh theo
// gian hàng, danh mục) chưa làm trong MVP (chốt 17/11/2026).
import { Decimal } from 'decimal.js';

export interface FeeInput {
  /** Tổng bốn loại phí % của cấu hình `fee` (cộng bằng Decimal: 4,15 + 3,3 + 1,2 + 0,55 phải ra đúng 9,2). */
  feePct: Decimal.Value;
  /** Phí cố định mỗi món (đồng). */
  perItemFee: number;
  /** Bậc làm tròn lên (đồng, > 0) và đuôi (0 ≤ đuôi < bậc): bậc 10.000 đuôi 9.000 → …9.000. */
  roundStep: number;
  roundEnding: number;
}

export interface PriceFilterInput {
  target: string;
  fee: FeeInput;
  /** Phần thuế cộng vào tổng phí (`taxPctFor`). */
  taxPct: Decimal.Value;
  /** Giá vốn bước 5; null khi chưa có. */
  cost: string | null;
  minMarginPct: number;
  /** Giá ghi đè tay (bước 6): thay giá tính được, vẫn xét bước 5. */
  manualPrice?: string | null;
}

export type PriceFilterResult =
  | {
      ok: true;
      /** Giá sau bước 2 (chưa làm tròn), hai chữ số; ghi đè tay thì bằng giá ghi đè. */
      rawPrice: string;
      price: string;
      net: string;
      /** Lãi gộp trên thực nhận (%), như lãi theo đơn của finance; null khi chưa có giá vốn hoặc ngoài khoảng lưu được. */
      marginPct: string | null;
      floor: string | null;
      belowFloor: boolean | null;
      totalPct: string;
      feeWarning: 'over_50' | null;
    }
  | { ok: false; error: 'fee_config_invalid' };

/**
 * Phần thuế cộng vào tổng phí (25 §6.2 bước 2): hộ kinh doanh, cá nhân là GTGT + TNCN sàn khấu trừ; doanh nghiệp là
 * `v / (1 + v)` của GTGT đầu ra (giá niêm yết đã gồm GTGT); chưa có cấu hình thì 0.
 */
export function taxPctFor(
  regime: { regime: 'company' | 'household' | 'individual' } | undefined,
  rules: { vatPct: number; pitPct: number; outputVatPct: number } | undefined,
): Decimal {
  if (!regime || !rules) return new Decimal(0);
  if (regime.regime !== 'company') return new Decimal(rules.vatPct).plus(rules.pitPct);
  const v = new Decimal(rules.outputVatPct).div(100);
  return v.div(v.plus(1)).times(100);
}

const toDong = (d: Decimal) => d.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);

export function priceFilter(i: PriceFilterInput): PriceFilterResult {
  const totalPct = new Decimal(i.fee.feePct).plus(i.taxPct);
  if (totalPct.isNegative() || totalPct.gte(100)) return { ok: false, error: 'fee_config_invalid' };
  const keep = new Decimal(1).minus(totalPct.div(100));
  let raw: Decimal, price: Decimal;
  if (i.manualPrice != null) {
    raw = price = new Decimal(i.manualPrice);
  } else {
    // Bước 2: bù phí; bước 4: làm tròn lên theo bậc và đuôi.
    raw = new Decimal(i.target).plus(i.fee.perItemFee).div(keep);
    price = raw.minus(i.fee.roundEnding).div(i.fee.roundStep).ceil().times(i.fee.roundStep).plus(i.fee.roundEnding);
  }
  // Bước 5: thực nhận so với giá thấp nhất.
  const net = toDong(price.times(keep).minus(i.fee.perItemFee));
  const floor = i.cost === null ? null : new Decimal(i.cost).times(new Decimal(1).plus(new Decimal(i.minMarginPct).div(100)));
  const margin = i.cost === null || net.lte(0) ? null : net.minus(i.cost).div(net).times(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return {
    ok: true,
    rawPrice: raw.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(),
    price: price.toFixed(),
    net: net.toFixed(),
    floor: floor && floor.toFixed(),
    belowFloor: floor && net.lt(floor),
    marginPct: margin && margin.abs().lt(100000) ? margin.toFixed(2) : null,
    totalPct: totalPct.toFixed(),
    feeWarning: totalPct.gt(50) ? 'over_50' : null,
  };
}

/**
 * Giá muốn bán tính ngược từ giá niêm yết P (#500, tạo SKU kho từ SKU sàn): `P × (1 − tổng %) − phí mỗi món` (25 §6.2,
 * công thức thực nhận ở bước 5), rồi dò để bộ lọc (bước 2, 4) chạy với số này ra đúng P: số lớn nhất mà bộ lọc ra ≤ P.
 * Dò theo đồng; mỗi đồng giá muốn bán đổi giá thô 1/(1 − tổng %) > 1 đồng nên với bậc làm tròn nhỏ có thể nhảy qua P, khi
 * đó dò lại theo 0,01 đồng (cột `numeric(18,2)`). P không nằm trên lưới làm tròn (bậc, đuôi) thì bộ lọc không ra được P:
 * lấy số nhỏ nhất cho giá ≥ P (không đề xuất giá thấp hơn giá đang bán). Tổng % không hợp lệ hoặc thực nhận ≤ 0 thì null.
 */
export function targetForPrice(price: string, fee: FeeInput, taxPct: Decimal.Value): string | null {
  const totalPct = new Decimal(fee.feePct).plus(taxPct);
  if (totalPct.isNegative() || totalPct.gte(100)) return null;
  const p = new Decimal(price);
  const listed = (t: Decimal) => {
    const r = priceFilter({ target: t.toFixed(), fee, taxPct, cost: null, minMarginPct: 0 });
    return r.ok ? new Decimal(r.price) : p;
  };
  const exact = p.times(new Decimal(1).minus(totalPct.div(100))).minus(fee.perItemFee);
  const search = (unit: Decimal) => {
    let t = exact.div(unit).floor().times(unit);
    // Bộ lọc tăng theo giá muốn bán; vài bước là tới.
    while (t.gt(unit) && listed(t).gt(p)) t = t.minus(unit);
    while (listed(t.plus(unit)).lte(p)) t = t.plus(unit);
    return t;
  };
  if (exact.lte(0)) return null;
  let t = search(new Decimal(1));
  if (listed(t).lt(p)) {
    const cents = search(new Decimal('0.01'));
    t = listed(cents).eq(p) ? cents : t.plus(1);
  }
  return t.gt(0) ? t.toFixed() : null;
}

/** Quy tắc làm tròn đã áp cho giá bộ lọc (Documents/21 §18.11 `PriceRounding`); đuôi 0 trả `null` như ví dụ của hợp đồng. */
export interface PriceRounding {
  step: number;
  ending: number | null;
  /** Giá sau bước 2, làm tròn tới đồng để hiện. */
  before: number;
  after: number;
}

/** Giá trước, sau bước 4 của một lần tính bộ lọc (không áp cho giá gõ tay: bên gọi trả `null`). Hàm thuần. */
export function roundingOf(
  fee: Pick<FeeInput, 'roundStep' | 'roundEnding'>,
  calc: { rawPrice: string; roundedPrice: string },
): PriceRounding {
  return {
    step: fee.roundStep,
    ending: fee.roundEnding === 0 ? null : fee.roundEnding,
    before: toDong(new Decimal(calc.rawPrice)).toNumber(),
    after: Number(calc.roundedPrice),
  };
}
