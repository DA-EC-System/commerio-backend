// Tính lại giá theo gian hàng (#225; Documents/25 §6.2, 21 §11.2, §18.6.7). Đổi giá muốn bán hay kích hoạt cấu hình phí,
// thuế, lãi tối thiểu thì mỗi listing có bản chờ xác nhận (`price_calculations`); giá đang bán chỉ đổi khi người dùng
// xác nhận. Đổi giá vốn không tạo bản chờ: cờ Dưới giá thấp nhất của giá đang bán tính lúc đọc (`listings.ts`).
// Consumer chạy trong `withCompany`.
import type { EventPayload } from '../../../core/index.ts';
import { targetNetPricesOf } from '../../../product/index.ts';
import { priceFilter } from '../domain/price-filter.ts';
import { currentListingRows } from '../repository/listings.ts';
import { findCalculations, insertPending, supersedePending } from '../repository/price-calculations.ts';
import type { PriceCalcTrigger } from '../repository/schema.ts';
import { listShopRows } from '../repository/shops.ts';
import { costsOf, shopPriceConfig } from './price-inputs.ts';

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
    const target = targets.get(variantId);
    const cost = costs.get(variantId) ?? null;
    const r = target ? priceFilter({ target: target.toFixed(), fee: config.fee, taxPct: config.taxPct, cost, minMarginPct: config.minMarginPct }) : null;
    const inUse = l.priceCalcId ? current.get(l.priceCalcId) : undefined;
    if (!r?.ok || (inUse && Number(inUse.roundedPrice) === Number(r.price))) {
      await supersedePending(shopId, variantId);
      continue;
    }
    await insertPending({
      shopId,
      variantId,
      feeVersionId: config.feeConfigId,
      taxVersionId: config.taxRulesVersionId,
      taxRegimeVersionId: config.taxRegimeVersionId,
      minMarginVersionId: config.minMarginVersionId,
      cost,
      targetNet: target!.toFixed(),
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
    });
  }
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
