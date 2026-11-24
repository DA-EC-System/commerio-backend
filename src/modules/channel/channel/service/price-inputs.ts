// Đầu vào của bộ lọc giá theo gian hàng (#225, 25 §6.2): phí, thuế, lãi tối thiểu đang áp dụng (finance) và giá muốn
// bán, giá vốn của SKU (product). Gọi trong `withCompany`.
import { Decimal } from 'decimal.js';
import { type ConfigPayload, feePctOf, feeRoundingOf, getEffectiveConfig, vnDate } from '../../../finance/index.ts';
import { getVariants, lastCostsOf, stockOf } from '../../../product/index.ts';
import { pathIdsOf } from '../repository/platform-categories.ts';
import { variantCategoryIds } from '../repository/fee-categories.ts';
import { type FeeInput, priceFilter, type PriceFilterResult, taxPctFor } from '../domain/price-filter.ts';

const feeSum = (p: ConfigPayload<'fee'>, pathIds?: readonly string[]) => new Decimal(feePctOf(p, pathIds)).toDecimalPlaces(2).toFixed();

export interface ShopPriceConfig {
  /**
   * Null khi gian hàng chưa có phí đang áp dụng: listing dùng giá chuẩn (`priceSource = standard`). `feePct` theo hoa hồng
   * mặc định; SKU có category khớp `categoryRates` thì lấy phí riêng bằng `variantFees`.
   */
  fee: FeeInput | null;
  /** Nội dung cấu hình phí đang áp dụng (để chọn hoa hồng theo category, Documents/21 §21.4). */
  feePayload: ConfigPayload<'fee'> | null;
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
    feePayload: fee?.payload ?? null,
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
 * Chuỗi `externalId` category sàn từ gốc tới category của từng SKU ở gian hàng (Documents/21 §21.4): category của listing
 * chưa gỡ, không thì của thông tin sàn của sản phẩm; category chưa có trong cây đã đồng bộ thì chuỗi chỉ có chính nó. SKU
 * không có category thì vắng. Một chỗ cho bộ lọc giá (`variantFees`) và sổ tiền của finance (`ctx.feeCategoryPathsOf`,
 * phí ước tính khi kiện giao, hồi tố), để cả hai cùng chọn tỷ lệ bằng `fixedPctFor`. Gọi trong `withCompany`.
 */
export async function variantCategoryPaths(shopId: string, variantIds: readonly string[]): Promise<Map<string, string[]>> {
  const ids = [...new Set(variantIds)];
  if (!ids.length) return new Map();
  const productOf = new Map((await getVariants(ids)).map((v) => [v.id, v.productId]));
  const { platform, categories } = await variantCategoryIds(shopId, productOf);
  const paths = platform ? await pathIdsOf(platform, [...categories.values()]) : new Map<string, string[]>();
  return new Map([...categories].map(([id, category]) => [id, paths.get(category) ?? [category]]));
}

/**
 * Phí của từng SKU ở gian hàng (Documents/21 §21.4): hoa hồng theo category sàn của SKU (listing, không thì thông tin sàn
 * của sản phẩm), dòng `categoryRates` gần nhất thắng, không khớp thì hoa hồng mặc định. Cấu hình không có `categoryRates`
 * thì mọi SKU dùng `config.fee`, không truy vấn thêm. Chưa có phí thì Map rỗng. Gọi trong `withCompany`.
 */
export async function variantFees(shopId: string, config: ShopPriceConfig, variantIds: readonly string[]): Promise<Map<string, FeeInput>> {
  const { fee, feePayload } = config;
  if (!fee || !feePayload) return new Map();
  const ids = [...new Set(variantIds)];
  if (!feePayload.categoryRates?.length) return new Map(ids.map((id) => [id, fee]));
  const paths = await variantCategoryPaths(shopId, ids);
  return new Map(ids.map((id) => [id, { ...fee, feePct: feeSum(feePayload, paths.get(id)) }]));
}

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
  const fees = await variantFees(shopId, config, [...prices.keys()]);
  const results = new Map(
    [...prices].map(([id, price]) => [
      id,
      priceFilter({
        target: '0',
        fee: fees.get(id) ?? NO_FEE,
        taxPct: config.taxPct,
        cost: costs.get(id) ?? null,
        minMarginPct: config.minMarginPct,
        manualPrice: price,
      }),
    ]),
  );
  return { hasFee: config.fee !== null, results };
}
