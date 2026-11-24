// Kiểm một biến thể trước khi đăng lên một gian hàng, dùng chung cho `push`, `push-preview` (be#566) và readiness (be#564),
// để ba lối không lệch mã chặn (Documents/21 §18.10, §18.11, §18.6.4). `loadPushContext` đọc mọi dữ liệu một lần cho cả lô
// (không đọc theo từng dòng); `checkVariant` là hàm thuần trên dữ liệu đã đọc.
import { Decimal } from 'decimal.js';
import type { BlockItem } from '../domain/blocker.ts';
import type { PriceFilterResult } from '../domain/price-filter.ts';
import type { ListingStatus } from '../domain/listing.ts';
import { currentListingRowsOf, type ListingRow } from '../repository/listings.ts';
import type { NewPriceCalculation } from '../repository/price-calculations.ts';
import type { ShopRow } from '../repository/shops.ts';
import { currentPrices } from './listing-prices.ts';
import { evaluatePrices, shopPriceConfig } from './price-inputs.ts';
import type { ListingVariant, ProductPort } from './product-port.ts';
import { type SpecCheckFull, specChecks } from './product-specs.ts';
import { feeBlock, groupBlock, keepsPlatformContent, pushBlocks, pushSpec, type VariantImageGap, variantImageGaps } from './push-block.ts';
import { firstPushCalculations } from './repricing.ts';
import { PUSH_IMAGE_MAX } from './shop-jobs.ts';
import { platformOf } from './shops.ts';

/** Listing đã lên sàn hoặc đang chờ sàn duyệt: đăng lại là `already_listed`. */
export const LISTED: readonly ListingStatus[] = ['under_review', 'live', 'hidden'];

export interface PushContext {
  shop: Pick<ShopRow, 'id' | 'shopName'>;
  variants: ReadonlyMap<string, ListingVariant>;
  /** Mọi biến thể của các sản phẩm trong lô (kể cả ngoài lô), để kiểm spec và ảnh theo giá trị. */
  siblings: readonly ListingVariant[];
  standard: ReadonlyMap<string, Decimal | null>;
  specs: ReadonlyMap<string, SpecCheckFull>;
  gaps: ReadonlyMap<string, VariantImageGap>;
  current: ReadonlyMap<string, ListingRow>;
  /** Giá đang bán của listing (ghi đè > giá gian hàng đã xác nhận > giá chuẩn), như lượt đồng bộ sẽ đẩy. */
  selling: ReadonlyMap<string, number | null>;
  images: ReadonlyMap<string, string[]>;
  sizeCharts: ReadonlyMap<string, string>;
  feeConfigured: boolean;
  /** Giá gõ lúc đăng (21 §18.9 R1), là giá ghi đè tay. */
  manual: ReadonlyMap<string, string>;
  manualChecks: ReadonlyMap<string, PriceFilterResult>;
  /** Giá bộ lọc của lần đẩy đầu (#225 phần 2). */
  calcs: ReadonlyMap<string, NewPriceCalculation>;
  /** Biến thể của lô chưa có sản phẩm trên sàn, theo sản phẩm: sẽ gom thành một sản phẩm sàn (§18.8.4). */
  newByProduct: ReadonlyMap<string, readonly ListingVariant[]>;
}

export interface VariantCheck {
  items: BlockItem[];
  /** Giá lần đăng sẽ gửi: giá gõ, giá bộ lọc lần đầu (`calc`), hoặc giá đang bán; null khi chưa có. */
  price: { value: string | null; calc?: { rawPrice: string; roundedPrice: string } };
  existing: ListingRow | undefined;
}

/** Lần đăng đầu, đăng lại sau gỡ, hay `push_failed` chưa có giá ghi đè, lần tính: lần đẩy sẽ dùng giá bộ lọc. */
const usesFilterPrice = (l: ListingRow | undefined) => !l || l.status === 'delisted' || (l.manualPrice === null && l.priceCalcId === null);

/** Đọc mọi dữ liệu cần để kiểm các biến thể trên một gian hàng; gọi trong `withCompany`. */
export async function loadPushContext(
  port: ProductPort,
  shop: ShopRow,
  variantIds: readonly string[],
  listPrices?: Readonly<Record<string, number>>,
): Promise<PushContext> {
  const ids = [...new Set(variantIds)];
  const { adapter } = platformOf(shop.platform);
  const variants = new Map((await port.variants(ids)).map((v) => [v.id, v]));
  const productIds = [...new Set([...variants.values()].map((v) => v.productId))];
  const siblings = await port.variants(undefined, { productIds });
  const [standard, specs, current, images, sizeCharts, config] = await Promise.all([
    port.standardPrices(ids),
    specChecks(port, shop, adapter, siblings),
    currentListingRowsOf(shop.id, ids),
    port.productImageUrls(productIds, PUSH_IMAGE_MAX),
    port.productSizeChartUrls?.(productIds) ?? Promise.resolve(new Map<string, string>()),
    shopPriceConfig(shop.id),
  ]);
  const manual = new Map(ids.flatMap((id) => (listPrices?.[id] === undefined ? [] : [[id, String(listPrices[id])] as const])));
  const firstPush = ids.filter((id) => !manual.has(id) && usesFilterPrice(current.get(id)));
  const [calcs, manualChecks, selling] = await Promise.all([
    firstPushCalculations(shop.id, firstPush),
    manual.size ? evaluatePrices(shop.id, manual).then((r) => r.results) : Promise.resolve(new Map<string, PriceFilterResult>()),
    currentPrices(ids, [...current.values()], standard),
  ]);
  const newByProduct = new Map<string, ListingVariant[]>();
  for (const id of ids) {
    const v = variants.get(id);
    if (!v || v.archived || current.get(id)?.externalProductId) continue;
    newByProduct.set(v.productId, [...(newByProduct.get(v.productId) ?? []), v]);
  }
  return {
    shop,
    variants,
    siblings,
    standard,
    specs,
    gaps: variantImageGaps(adapter, siblings),
    current,
    selling: new Map([...selling].map(([id, p]) => [id, p.price])),
    images,
    sizeCharts,
    feeConfigured: config.fee !== null,
    manual,
    manualChecks,
    calcs,
    newByProduct,
  };
}

const listingItem = (code: BlockItem['code'], label: string, existing: ListingRow | undefined): BlockItem => ({
  code,
  label,
  target: { kind: 'listing', listingId: existing?.id ?? null },
});

/**
 * Mọi mục chặn của một biến thể trên gian hàng, theo thứ tự của `push` (21 §18.6.4): mã theo trạng thái listing (chỉ một mục,
 * vì dữ liệu không còn quyết định), rồi `fee_not_configured`, mục của `pushBlocks`, gom biến thể (`axis_shape`, `axis_unmapped`,
 * khi spec không còn thiếu), cuối cùng `below_floor`.
 */
export function checkVariant(ctx: PushContext, variantId: string): VariantCheck {
  const v = ctx.variants.get(variantId);
  const existing = ctx.current.get(variantId);
  const manualPrice = ctx.manual.get(variantId);
  const calc = ctx.calcs.get(variantId);
  const selling = ctx.selling.get(variantId) ?? null;
  const price: VariantCheck['price'] = {
    value: manualPrice ?? (calc ? String(calc.roundedPrice) : selling === null ? null : String(selling)),
    ...(calc && !manualPrice && { calc: { rawPrice: String(calc.rawPrice), roundedPrice: String(calc.roundedPrice) } }),
  };
  const only = (item: BlockItem): VariantCheck => ({ items: [item], price, existing });
  if (!v || v.archived) return only(listingItem('not_found', 'Biến thể không còn bán', existing));
  if (existing?.status === 'pushing') return only(listingItem('push_in_progress', 'Đang đăng bán, chờ sàn trả kết quả', existing));
  // CHECK `listings_pending_external`: SKU sàn chờ ghép chỉ nằm trên listing `push_failed` (#346).
  if (existing?.pendingExternalSkuId) {
    return only(listingItem('mapping_pending', 'Listing đang chờ CEO duyệt liên kết SKU sàn có sẵn; duyệt hoặc từ chối trước khi đăng bán lại', existing));
  }
  if (existing && LISTED.includes(existing.status)) return only(listingItem('already_listed', 'Đã có trên sàn: giá và tồn cập nhật bằng Đồng bộ', existing));

  const items: BlockItem[] = [];
  const fee = feeBlock(ctx.shop, existing, ctx.feeConfigured);
  if (fee) items.push(fee);
  const keep = keepsPlatformContent(existing);
  const spec = ctx.specs.get(v.productId);
  items.push(
    ...pushBlocks(
      v,
      // Ô giá của `price_missing` theo giá chuẩn như trước #564: giá gõ hay giá bộ lọc thì đã có giá.
      manualPrice ? new Decimal(manualPrice) : calc ? new Decimal(calc.roundedPrice) : (ctx.standard.get(variantId) ?? null),
      // Đẩy lại SKU người bán chỉ bật lại trên sàn: không xét spec (cùng vị từ với việc nền).
      pushSpec(keep, spec),
      Boolean(existing?.externalImageUrls?.length || ctx.images.get(v.productId)?.length),
      ctx.sizeCharts.has(v.productId),
      keep ? null : (ctx.gaps.get(v.productId) ?? null),
    ),
  );
  if (!keep && !existing?.externalProductId) {
    const group = groupBlock(
      (ctx.newByProduct.get(v.productId) ?? []).map((s) => ({ id: s.id, attributes: s.attributes, image: s.image ?? null })),
      spec,
    );
    if (group) items.push(group);
  }
  const manualCheck = ctx.manualChecks.get(variantId);
  if (calc?.belowFloor) {
    items.push({
      code: 'below_floor',
      label: 'Giá theo bộ lọc giá của gian hàng có thực nhận dưới giá thấp nhất; sửa giá muốn bán hoặc cấu hình phí',
      target: { kind: 'variant_field', field: 'price' },
    });
  } else if (manualCheck && (!manualCheck.ok || manualCheck.belowFloor)) {
    // Như `assertAboveFloor` của `PUT .../price`: tổng phí từ 100% trở lên cũng là dưới giá thấp nhất.
    items.push({ code: 'below_floor', label: 'Giá niêm yết có thực nhận dưới giá thấp nhất; nhập giá cao hơn', target: { kind: 'variant_field', field: 'price' } });
  }
  return { items, price, existing };
}
