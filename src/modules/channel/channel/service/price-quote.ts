// Tính thử giá niêm yết → thực nhận theo từng gian hàng (Documents/21 §18.9 R1, 25 §6.2). Không ghi gì. Gọi trong `withCompany`.
// Số mặc định (giá bộ lọc lần đăng sẽ gửi) đã có ở `GET` listings; route này cho giá người bán gõ thử, cùng bước 5 với
// `ListingRow` (`evaluatePrices`) nên số khớp nhau. Không trả giá thấp nhất (suy ra được giá vốn); biên lãi chỉ khi người gọi
// xem được giá vốn.
import { AppError } from '../../../../shared/errors/app-error.ts';
import type { ProductPort } from './product-port.ts';
import { evaluatePrices, shopPriceConfig } from './price-inputs.ts';
import { firstPushCalculations } from './repricing.ts';
import { ownShop } from './shops.ts';

export const COST_VIEW = 'inventory.cost.view';

export interface QuoteItem {
  shopId: string;
  variantId: string;
  listPrice?: number;
}

export interface Quote {
  shopId: string;
  variantId: string;
  listPrice: number | null;
  netReceived: number | null;
  belowFloor: boolean | null;
  feeWarning: 'over_50' | null;
  feeConfigId: string | null;
  blocked: { code: 'price_missing' | 'fee_config_invalid' | 'fee_not_configured' } | null;
  marginPct?: number | null;
}

const empty = { netReceived: null, belowFloor: null, feeWarning: null } as const;

export async function quotePrices(port: ProductPort, productId: string, items: readonly QuoteItem[], canSeeCost: boolean): Promise<Quote[]> {
  const own = new Set((await port.variants(undefined, { productIds: [productId] })).map((v) => v.id));
  const errors: Record<string, string> = {};
  items.forEach((it, i) => {
    if (!own.has(it.variantId)) errors[`items.${i}.variantId`] = 'SKU không thuộc sản phẩm này';
  });
  if (Object.keys(errors).length) throw new AppError(422, 'validation_failed', 'Dữ liệu không hợp lệ', { errors });

  const byShop = new Map<string, QuoteItem[]>();
  for (const it of items) byShop.set(it.shopId, [...(byShop.get(it.shopId) ?? []), it]);
  const out = new Map<QuoteItem, Quote>();
  // Cùng một kết nối của giao dịch: đọc tuần tự từng gian hàng.
  for (const [shopId, list] of byShop) {
    await ownShop(shopId);
    const config = await shopPriceConfig(shopId);
    const base = (it: QuoteItem) => ({ shopId, variantId: it.variantId, feeConfigId: config.feeConfigId });
    if (!config.fee) {
      for (const it of list) out.set(it, { ...base(it), listPrice: it.listPrice ?? null, ...empty, blocked: { code: 'fee_not_configured' } });
      continue;
    }
    // Thiếu giá gõ thử: giá bộ lọc lần đăng sẽ gửi (cùng hàm với lúc đẩy); không tính được là chưa có giá muốn bán.
    const preview = await firstPushCalculations(
      shopId,
      list.filter((it) => it.listPrice === undefined).map((it) => it.variantId),
    );
    const priceOf = (it: QuoteItem) => (it.listPrice !== undefined ? String(it.listPrice) : preview.get(it.variantId)?.roundedPrice);
    const prices = new Map(list.flatMap((it) => (priceOf(it) === undefined ? [] : [[it.variantId, priceOf(it)!] as const])));
    const { results } = await evaluatePrices(shopId, prices);
    for (const it of list) {
      const price = priceOf(it);
      if (price === undefined) {
        out.set(it, { ...base(it), listPrice: null, ...empty, blocked: { code: 'price_missing' } });
        continue;
      }
      // Hai dòng cùng SKU, giá gõ khác nhau: tính riêng từng dòng.
      const r = prices.get(it.variantId) === price ? results.get(it.variantId)! : (await evaluatePrices(shopId, new Map([[it.variantId, price]]))).results.get(it.variantId)!;
      const quote: Quote = r.ok
        ? { ...base(it), listPrice: Number(price), netReceived: Number(r.net), belowFloor: r.belowFloor, feeWarning: r.feeWarning, blocked: null }
        : { ...base(it), listPrice: Number(price), ...empty, blocked: { code: 'fee_config_invalid' } };
      if (canSeeCost) quote.marginPct = r.ok && r.marginPct !== null ? Number(r.marginPct) : null;
      out.set(it, quote);
    }
  }
  return items.map((it) => out.get(it)!);
}
