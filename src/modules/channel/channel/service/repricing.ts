// Tính lại giá theo gian hàng (#225; Documents/25 §6.2, 21 §11.2, §18.6.7). Đổi giá muốn bán hay kích hoạt cấu hình phí,
// thuế, lãi tối thiểu thì mỗi listing có bản chờ xác nhận (`price_calculations`); giá đang bán chỉ đổi khi người dùng
// xác nhận. Đổi giá vốn: cờ Dưới giá thấp nhất của giá đang bán tính lúc đọc (`listings.ts`); listing đang bán rơi dưới
// giá thấp nhất thì có thêm bản chờ đề xuất giá mới (`trigger = cost`), không tự đổi giá.
// Consumer chạy trong `withCompany`.
import { Decimal } from 'decimal.js';
import type { EventPayload } from '../../../core/index.ts';
import { targetNetPricesOf } from '../../../product/index.ts';
import { priceFilter } from '../domain/price-filter.ts';
import { currentListingRows, listListingRows } from '../repository/listings.ts';
import { findCalculations, insertPending, type NewPriceCalculation, pendingCalculations, supersedePending } from '../repository/price-calculations.ts';
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

/**
 * Giá vốn có thể đã đổi (#225 A1; 25 §6.2 "Listing nào rơi dưới giá thấp nhất thì cảnh báo và đề xuất giá mới; không tự
 * đổi"). Với listing đang bán (`live`, `hidden`) của các SKU mà giá đang trên sàn (`listed_price`) cho thực nhận dưới giá
 * thấp nhất theo giá vốn hiện tại: ra bản chờ `trigger = cost`, giá là bộ lọc chạy với thực nhận mục tiêu = max(giá muốn
 * bán, giá thấp nhất làm tròn lên đồng), nên luôn đủ giá thấp nhất và xác nhận được. Đã có bản chờ đủ giá thấp nhất (vd vừa
 * đổi giá muốn bán) thì giữ. Gian hàng chưa có phí, SKU chưa có giá vốn thì bỏ qua (cờ vẫn tính lúc đọc).
 */
export async function proposeForCost(shopId: string, variantIds: readonly string[], now = new Date()) {
  // `live`, `hidden` là dòng hiện hành của SKU (mỗi SKU một dòng chưa gỡ), đọc theo SKU vì sự kiện bắn mỗi lần tồn đổi.
  const rows = (await listListingRows(shopId, variantIds)).filter((l) => (l.status === 'live' || l.status === 'hidden') && l.listedPrice !== null);
  if (!rows.length) return;
  const config = await shopPriceConfig(shopId, now);
  if (!config.fee) return;
  const fee = config.fee;
  const ids = rows.map((l) => l.variantId!);
  const [targets, costs, pending] = await Promise.all([targetNetPricesOf(ids), costsOf(ids), pendingCalculations(shopId, ids)]);
  const below = (cost: string, price: string) =>
    priceFilter({ target: '0', fee, taxPct: config.taxPct, cost, minMarginPct: config.minMarginPct, manualPrice: price });
  for (const l of rows) {
    const variantId = l.variantId!;
    const cost = costs.get(variantId) ?? null;
    if (cost === null) continue;
    const selling = below(cost, l.listedPrice!);
    if (!selling.ok || !selling.belowFloor) continue;
    const queued = pending.get(variantId);
    if (queued) {
      const r = below(cost, queued.roundedPrice);
      if (r.ok && r.belowFloor === false) continue;
    }
    const floor = new Decimal(cost).times(new Decimal(1).plus(new Decimal(config.minMarginPct).div(100))).ceil();
    const target = targets.get(variantId);
    const net = target && new Decimal(target.toFixed()).gt(floor) ? new Decimal(target.toFixed()) : floor;
    const calc = calculationOf(shopId, variantId, config, net, cost, 'cost');
    if (calc) await insertPending(calc);
  }
}

/** Gian hàng còn nối (chưa ngắt) của công ty. */
const liveShops = async () => (await listShopRows()).filter((s) => s.status !== 'disconnected');

export async function onVariantPriceChanged(e: EventPayload<'catalog.variant_price_changed'>): Promise<void> {
  for (const s of await liveShops()) await repriceShop(s.id, 'target_changed', [e.variantId]);
}

/** Tồn thực đổi (`inventory.stock_changed`): giá vốn bình quân chỉ đổi khi nhập có giá, hết tồn thì giá vốn lấy giá đề nghị nhập. */
export async function onStockChanged(e: EventPayload<'inventory.stock_changed'>): Promise<void> {
  for (const s of await liveShops()) await proposeForCost(s.id, [e.variantId]);
}

export async function onConfigActivated(e: EventPayload<'finance.fee_config_activated'>): Promise<void> {
  if (!PRICE_KINDS.has(e.kind)) return;
  for (const s of await liveShops()) if (e.shopId === null || e.shopId === s.id) await repriceShop(s.id, 'config_activated');
}
