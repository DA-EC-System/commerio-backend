// Đầu vào của bộ lọc giá theo gian hàng (#225, 25 §6.2): phí, thuế, lãi tối thiểu đang áp dụng (finance) và giá muốn
// bán, giá vốn của SKU (product). Gọi trong `withCompany`.
import { Decimal } from 'decimal.js';
import { type ConfigPayload, feeRoundingOf, getEffectiveConfig, vnDate } from '../../../finance/index.ts';
import { lastCostsOf, stockOf } from '../../../product/index.ts';
import { type FeeInput, priceFilter, type PriceFilterResult, taxPctFor } from '../domain/price-filter.ts';

const feeSum = (p: ConfigPayload<'fee'>) =>
  new Decimal(p.fixedPct).plus(p.transactionPct).plus(p.servicePct).plus(p.optionalPct).toFixed();

export interface ShopPriceConfig {
  /** Null khi gian hàng chưa có phí đang áp dụng: listing dùng giá chuẩn (`priceSource = standard`). */
  fee: FeeInput | null;
  feeConfigId: string | null;
  taxRegimeVersionId: string | null;
  taxRulesVersionId: string | null;
  minMarginVersionId: string | null;
  taxPct: Decimal;
  /** Lãi tối thiểu cấp công ty; chưa cấu hình thì 0 (giá thấp nhất = giá vốn). */
  minMarginPct: number;
}

export async function shopPriceConfig(shopId: string, now = new Date()): Promise<ShopPriceConfig> {
  const day = vnDate(now);
  const [fee, regime, rules, margin] = await Promise.all([
    getEffectiveConfig('fee', shopId, day),
    getEffectiveConfig('tax_regime', null, day),
    getEffectiveConfig('tax_rules', null, day),
    getEffectiveConfig('min_margin', null, day),
  ]);
  return {
    fee: fee ? { feePct: feeSum(fee.payload), ...feeRoundingOf(fee.payload) } : null,
    feeConfigId: fee?.id ?? null,
    taxRegimeVersionId: regime?.id ?? null,
    taxRulesVersionId: rules?.id ?? null,
    minMarginVersionId: margin?.id ?? null,
    // Giữ 4 chữ số như cột `tax_pct`: số lưu ở lần tính bằng đúng số đã dùng.
    taxPct: taxPctFor(regime?.payload, rules?.payload).toDecimalPlaces(4, Decimal.ROUND_HALF_UP),
    minMarginPct: margin?.payload.pct ?? 0,
  };
}

/**
 * Giá vốn cho bước 5: giá vốn bình quân khi còn tồn; hết tồn thì giá nhập của đề nghị nhập gần nhất; không có cả hai thì
 * null (không bật cờ Dưới giá thấp nhất). Đủ mọi id đầu vào.
 */
export async function costsOf(variantIds: readonly string[]): Promise<Map<string, string | null>> {
  const stock = await stockOf(variantIds);
  const noStock = variantIds.filter((id) => !(stock.get(id)?.onHand ?? 0));
  const last = await lastCostsOf(noStock);
  return new Map(
    variantIds.map((id) => {
      const s = stock.get(id);
      return [id, s && s.onHand > 0 ? s.avgCost : (last.get(id)?.unitCost ?? null)];
    }),
  );
}

const NO_FEE: FeeInput = { feePct: 0, perItemFee: 0, roundStep: 1, roundEnding: 0 };

/**
 * Bước 5 cho các giá cho trước (giá đang bán, giá chờ, giá ghi đè) với phí, thuế, lãi tối thiểu, giá vốn **hiện tại**: giá
 * vốn đổi sau lần tính thì cờ theo giá vốn mới. Gian hàng chưa có phí thì tính với phí 0 (`hasFee = false`). Tổng phí từ
 * 100% trở lên thì thực nhận ≤ 0: `ok = false`.
 */
export async function evaluatePrices(
  shopId: string,
  prices: ReadonlyMap<string, string>,
): Promise<{ hasFee: boolean; results: Map<string, PriceFilterResult> }> {
  const [config, costs] = await Promise.all([shopPriceConfig(shopId), costsOf([...prices.keys()])]);
  const fee = config.fee ?? NO_FEE;
  const results = new Map(
    [...prices].map(([id, price]) => [
      id,
      priceFilter({ target: '0', fee, taxPct: config.taxPct, cost: costs.get(id) ?? null, minMarginPct: config.minMarginPct, manualPrice: price }),
    ]),
  );
  return { hasFee: config.fee !== null, results };
}
