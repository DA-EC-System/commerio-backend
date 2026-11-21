// Dựng sản phẩm nhiều SKU từ các listing có sẵn (#295, Documents/21 §18.8.4), dùng cho gom lại dữ liệu cũ
// (`product-regroup.ts`). Cùng cách dựng với `runProductPush` (`product-push.ts`); file này tách ra để việc gom không sửa
// thân `runProductPush`, sau này hai bên có thể dùng chung.
import { Decimal } from 'decimal.js';
import { responsibleOrgOf } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { groupVariants } from '../domain/variant-group.ts';
import type { ListingRow } from '../repository/listings.ts';
import type { ShopRow } from '../repository/shops.ts';
import { currentPrices } from './listing-prices.ts';
import { refreshPermission, sizeChartRuleOf, uploadAll, uploadAxisImages } from './listing-push.ts';
import { countedOf } from './listing-sync.ts';
import type { MarketplaceAdapter, NewProduct, ProductSku } from './marketplaces/index.ts';
import { evaluatePrices } from './price-inputs.ts';
import type { ListingVariant, ProductPort } from './product-port.ts';
import { ensureLeaf } from './platform-categories.ts';
import { pushAttributes, specChecks } from './product-specs.ts';
import { pushBlock } from './push-block.ts';
import { untrustedVariants } from './stock-trust.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { MarketplaceError } from './marketplaces/index.ts';

export interface ReadySku {
  row: ListingRow;
  v: ListingVariant;
  sku: ProductSku;
  priceText: string;
  shopPrice: boolean;
  untrusted: boolean;
}

export interface BlockedSku {
  row: ListingRow;
  code: string;
  message: string;
}

export type PreparedProduct =
  | { ok: false; blocked: BlockedSku[] }
  | { ok: true; product: NewProduct; ready: ReadySku[] };

/**
 * Dựng `NewProduct` một sản phẩm nhiều SKU cho `rows` (listing của các biến thể cùng một cha) trên `shop`. Mọi SKU phải đẩy
 * được: có SKU bị chặn (`pushBlock`, dưới giá thấp nhất, biến thể không còn bán) hoặc trục không gom được thì trả
 * `ok: false` kèm lý do từng dòng, không dựng gì. Ảnh đã nằm trên sàn (`uploadAll`) chỉ khi dựng được. Gọi ngoài giao dịch.
 */
export async function prepareNewProduct(args: {
  port: ProductPort;
  companyId: string;
  shop: ShopRow;
  adapter: MarketplaceAdapter;
  accessToken: string;
  productId: string;
  rows: readonly ListingRow[];
  imageUrls: readonly string[];
  sizeChartUrl: string | null | undefined;
  idempotencyKey: string;
}): Promise<PreparedProduct> {
  const { port, companyId, shop, adapter, accessToken, productId, rows } = args;
  const inCompany = <T>(fn: () => Promise<T>) => withCompany(companyId, fn);
  const specOf = async () => (await specChecks(port, shop, adapter, await port.variants(undefined, { productIds: [productId] }))).get(productId);
  const first = await inCompany(specOf);
  if (first && adapter.leafAttributes) {
    try {
      await ensureLeaf(shop.companyId, shop.platform, adapter, first.externalCategoryId, { shopId: shop.id });
    } catch (err) {
      if (!(err instanceof MarketplaceError) && !(err instanceof AppError)) throw err;
    }
  }
  if (first) await refreshPermission(shop, adapter, accessToken, first.externalCategoryId);
  const variantIds = rows.map((r) => r.variantId!);
  const data = await inCompany(async () => {
    const map = await specOf();
    const variants = new Map((await port.variants(variantIds)).map((v) => [v.id, v]));
    const prices = await currentPrices(variantIds, [...rows], await port.standardPrices(variantIds));
    const available = await port.availableOf(variantIds);
    const untrusted = await untrustedVariants();
    const counted = await countedOf(port, variantIds);
    const shopPrices = new Map(variantIds.flatMap((id) => (prices.get(id)?.priceSource === 'shop' ? [[id, String(prices.get(id)!.price)] as const] : [])));
    const floors = shopPrices.size ? (await evaluatePrices(shop.id, shopPrices)).results : new Map();
    return { map, variants, prices, available, untrusted, counted, floors, responsible: await responsibleOrgOf(shop.companyId) };
  });
  const { map } = data;
  const sizeChartRule = map ? await sizeChartRuleOf(adapter, accessToken, map) : null;
  const ready: ReadySku[] = [];
  const blocked: BlockedSku[] = [];
  for (const row of rows) {
    const v = data.variants.get(row.variantId!);
    if (!v || v.archived) {
      blocked.push({ row, code: 'not_found', message: 'Biến thể không còn bán' });
      continue;
    }
    const own = data.prices.get(v.id)!;
    const price = own.price === null ? null : new Decimal(own.price);
    const floor = data.floors.get(v.id);
    if (floor !== undefined && (!floor.ok || floor.belowFloor === true)) {
      blocked.push({ row, code: 'below_floor', message: 'Giá theo bộ lọc giá của gian hàng có thực nhận dưới giá thấp nhất' });
      continue;
    }
    const block = pushBlock(v, price, map && { ...map, sizeChartRule }, Boolean(args.imageUrls.length), Boolean(args.sizeChartUrl));
    if (block) {
      blocked.push({ row, code: block.code, message: block.message });
      continue;
    }
    const untrusted = data.untrusted.has(v.id);
    const quantity = untrusted || !data.counted.has(v.id) ? 0 : (data.available.get(v.id) ?? 0);
    const priceText = price!.toFixed(0);
    const sku: ProductSku = { sellerSku: row.sellerSku ?? v.sku, price: priceText, quantity, values: [], weightG: v.weightG!, lengthMm: v.lengthMm!, widthMm: v.widthMm!, heightMm: v.heightMm! };
    ready.push({ row, v, sku, priceText, shopPrice: own.priceSource === 'shop', untrusted });
  }
  if (blocked.length || !ready.length || !map) {
    return { ok: false, blocked: blocked.length ? blocked : rows.map((row) => ({ row, code: 'category_unmapped', message: 'Chưa chọn category của sàn cho sản phẩm' })) };
  }
  const group = groupVariants(
    ready.map((r) => ({ id: r.v.id, attributes: r.v.attributes, image: r.v.image ?? null })),
    map.row.axisMap,
    map.attributes,
  );
  if (!group.ok) return { ok: false, blocked: ready.map((r) => ({ row: r.row, code: group.code, message: group.message })) };
  for (const r of ready) r.sku.values = group.valuesOf.get(r.v.id)!;
  const lead = ready[0]!.v;
  const imageUrls = await uploadAll(adapter, accessToken, args.imageUrls);
  const salesAttributes = await uploadAxisImages(adapter, accessToken, group.axes);
  const sizeChartUri =
    args.sizeChartUrl && sizeChartRule !== 'unsupported' ? await adapter.uploadImage(accessToken, args.sizeChartUrl, 'size_chart') : null;
  const product: NewProduct = {
    externalCategoryId: map.externalCategoryId,
    attributes: pushAttributes(map.attributes, map.resolved),
    responsible: data.responsible,
    brand: lead.brand ?? null,
    name: lead.productName,
    description: lead.description ?? lead.productName,
    imageUrls,
    ...(sizeChartUri && { sizeChartUri }),
    ...ready[0]!.sku,
    ...(salesAttributes.length && { salesAttributes }),
    skus: ready.map((r) => r.sku),
    idempotencyKey: args.idempotencyKey,
    skipExistingSkuCheck: true,
  };
  return { ok: true, product, ready };
}
