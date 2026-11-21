// Tính thử giá niêm yết → thực nhận theo từng gian hàng (Documents/21 §18.9 R1, 25 §6.2). Không ghi gì. Gọi trong `withCompany`.
// Số mặc định (giá bộ lọc lần đăng sẽ gửi) đã có ở `GET` listings; route này cho giá người bán gõ thử, cùng bước 5 với
// `ListingRow` (`evaluatePrices`) nên số khớp nhau. Không trả giá thấp nhất. Người gọi thiếu `inventory.cost.view` nhận
// `belowFloor`, `marginPct` null (luật R4 của 21): route nhận giá tuỳ ý, cờ dưới giá thấp nhất cho mọi giá gõ thử là dò
// được giá thấp nhất rồi suy ra giá vốn.
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
  /** null khi người gọi thiếu `inventory.cost.view`, hoặc chưa có giá vốn. */
  marginPct: number | null;
}

const empty = { netReceived: null, belowFloor: null, feeWarning: null } as const;

export async function quotePrices(port: ProductPort, productId: string, items: readonly QuoteItem[], canSeeCost: boolean): Promise<Quote[]> {
  const own = new Set((await port.variants(undefined, { productIds: [productId] })).map((v) => v.id));
  const errors: Record<string, string> = {};
  // Mỗi (gian hàng, SKU) một dòng: nhiều giá cho cùng SKU trong một lần gọi là dò được giá thấp nhất qua `belowFloor`
  // (suy ra giá vốn) với người không có `inventory.cost.view`.
  const seen = new Set<string>();
  items.forEach((it, i) => {
    const key = `${it.shopId}:${it.variantId}`;
    if (!own.has(it.variantId)) errors[`items.${i}.variantId`] = 'SKU không thuộc sản phẩm này';
    else if (seen.has(key)) errors[`items.${i}.variantId`] = 'SKU đã có dòng cho gian hàng này';
    seen.add(key);
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
      for (const it of list) out.set(it, { ...base(it), listPrice: it.listPrice ?? null, ...empty, marginPct: null, blocked: { code: 'fee_not_configured' } });
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
        out.set(it, { ...base(it), listPrice: null, ...empty, marginPct: null, blocked: { code: 'price_missing' } });
        continue;
      }
      const r = results.get(it.variantId)!;
      out.set(
        it,
        r.ok
          ? {
              ...base(it),
              listPrice: Number(price),
              netReceived: Number(r.net),
              belowFloor: canSeeCost ? r.belowFloor : null,
              feeWarning: r.feeWarning,
              marginPct: canSeeCost && r.marginPct !== null ? Number(r.marginPct) : null,
              blocked: null,
            }
          : { ...base(it), listPrice: Number(price), ...empty, marginPct: null, blocked: { code: 'fee_config_invalid' } },
      );
    }
  }
  return items.map((it) => out.get(it)!);
}
