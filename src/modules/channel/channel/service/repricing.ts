// Tính lại giá theo gian hàng (#225; Documents/25 §6.2, 21 §11.2, §18.6.7). Đổi giá muốn bán hay kích hoạt cấu hình phí,
// thuế, lãi tối thiểu thì mỗi listing có bản chờ xác nhận (`price_calculations`); giá đang bán chỉ đổi khi người dùng
// xác nhận. Đổi giá vốn không tạo bản chờ: cờ Dưới giá thấp nhất của giá đang bán tính lúc đọc (`listings.ts`).
// Consumer chạy trong `withCompany`.
import type { EventPayload } from '../../../core/index.ts';
import { targetNetPricesOf } from '../../../product/index.ts';
import { priceFilter } from '../domain/price-filter.ts';
import { currentListingRows } from '../repository/listings.ts';
import { findCalculations, insertPending, type NewPriceCalculation, supersedePending } from '../repository/price-calculations.ts';
import type { PriceCalcTrigger } from '../repository/schema.ts';
import { listShopRows } from '../repository/shops.ts';
import { costsOf, type ShopPriceConfig, shopPriceConfig } from './price-inputs.ts';

const PRICE_KINDS = new Set(['fee', 'tax_regime', 'tax_rules', 'min_margin']);

/** Tính lại giá các SKU (mọi SKU nếu bỏ trống) đang có listing chưa gỡ trên gian hàng. */
export async function repriceShop(shopId: string, trigger: PriceCalcTrigger, variantIds?: readonly string[], now = new Date()) {
  const rows = (await currentListingRows(shopId)).filter(
    (l) => l.status !== 'delisted' && (!variantIds || variantIds.includes(l.variantId!)),
  );
  if (!rows.length) return;
  const config = await shopPriceConfig(shopId, now);
  if (!config.fee) {
    for (const l of rows) await supersedePending(shopId, l.variantId!);
    return;
  }
  const ids = rows.map((l) => l.variantId!);
  const [targets, costs, current] = await Promise.all([
    targetNetPricesOf(ids),
    costsOf(ids),
    findCalculations(rows.flatMap((l) => (l.priceCalcId ? [l.priceCalcId] : []))),
  ]);
  for (const l of rows) {
    const variantId = l.variantId!;
    const calc = calculationOf(shopId, variantId, config, targets.get(variantId), costs.get(variantId) ?? null, trigger);
    const inUse = l.priceCalcId ? current.get(l.priceCalcId) : undefined;
    if (!calc || (inUse && Number(inUse.roundedPrice) === Number(calc.roundedPrice))) {
      await supersedePending(shopId, variantId);
      continue;
    }
    await insertPending(calc);
  }
}

/** Một lần tính bước 1–5 của bộ lọc giá; không có giá muốn bán hay tổng phí không hợp lệ thì null. */
function calculationOf(
  shopId: string,
  variantId: string,
  config: ShopPriceConfig,
  target: { toFixed(): string } | null | undefined,
  cost: string | null,
  trigger: PriceCalcTrigger,
): NewPriceCalculation | null {
  if (!config.fee || !target) return null;
  const r = priceFilter({ target: target.toFixed(), fee: config.fee, taxPct: config.taxPct, cost, minMarginPct: config.minMarginPct });
  if (!r.ok) return null;
  return {
    shopId,
    variantId,
    feeVersionId: config.feeConfigId,
    taxVersionId: config.taxRulesVersionId,
    taxRegimeVersionId: config.taxRegimeVersionId,
    minMarginVersionId: config.minMarginVersionId,
    cost,
    targetNet: target.toFixed(),
    perItemFee: String(config.fee.perItemFee),
    feePct: String(config.fee.feePct),
    taxPct: config.taxPct.toFixed(4),
    minMarginPct: cost === null ? null : String(config.minMarginPct),
    rawPrice: r.rawPrice,
    roundedPrice: r.price,
    netReceived: r.net,
    marginPct: r.marginPct,
    belowFloor: r.belowFloor,
    trigger,
  };
}

/**
 * Giá bộ lọc cho lần đẩy đầu (#225 phần 2, 21 §18.6.4): gian hàng có cấu hình phí và SKU có giá muốn bán. SKU không có
 * trong Map thì đẩy giá chuẩn như trước. `belowFloor` true thì chặn đẩy `below_floor`.
 */
export async function firstPushCalculations(shopId: string, variantIds: readonly string[], now = new Date()): Promise<Map<string, NewPriceCalculation>> {
  if (!variantIds.length) return new Map();
  const config = await shopPriceConfig(shopId, now);
  if (!config.fee) return new Map();
  const [targets, costs] = await Promise.all([targetNetPricesOf(variantIds), costsOf(variantIds)]);
  return new Map(
    variantIds.flatMap((id) => {
      const calc = calculationOf(shopId, id, config, targets.get(id), costs.get(id) ?? null, 'push');
      return calc ? [[id, calc] as const] : [];
    }),
  );
}

/** Gian hàng còn nối (chưa ngắt) của công ty. */
const liveShops = async () => (await listShopRows()).filter((s) => s.status !== 'disconnected');

export async function onVariantPriceChanged(e: EventPayload<'catalog.variant_price_changed'>): Promise<void> {
  for (const s of await liveShops()) await repriceShop(s.id, 'target_changed', [e.variantId]);
}

export async function onConfigActivated(e: EventPayload<'finance.fee_config_activated'>): Promise<void> {
  if (!PRICE_KINDS.has(e.kind)) return;
  for (const s of await liveShops()) if (e.shopId === null || e.shopId === s.id) await repriceShop(s.id, 'config_activated');
}
