// Cổng của channel cho catalog (#204, Documents/21 §17.1, §17.3): lý do chặn lưu trữ SKU phần sàn, hiện diện trên sàn.
// `src/wiring.ts` nối vào `ctx` của catalog (product ở lớp dưới channel nên không gọi thẳng được). Gọi trong
// `withCompany` của bên gọi.
import type { ListingStatus } from '../domain/listing.ts';
import { type ListingPresence, presenceOf } from '../domain/presence.ts';
import { currentListingStatuses, listingShopPairs, pushingListingCounts, usedVariants } from '../repository/archive-blockers.ts';
import { listShopRows } from '../repository/shops.ts';
import { LISTED } from './push-check.ts';

/** Câu lý do theo SKU: listing đang đẩy lên sàn (`pushing`). SKU không vướng gì thì không có trong Map. */
export async function listingArchiveBlockers(variantIds: readonly string[]): Promise<Map<string, string[]>> {
  const pushing = await pushingListingCounts([...new Set(variantIds)]);
  return new Map([...pushing].map(([id, n]) => [id, [`Còn ${n} listing đang đẩy lên sàn`]]));
}

export interface VariantPresence {
  presence: ListingPresence;
  hasListingError: boolean;
  /** Số listing chưa gỡ, mọi gian hàng. */
  listingCount: number;
}

/** Hiện diện theo SKU (D8), một câu cho cả lô; Map đủ mọi id, SKU không có listing chưa gỡ là `not_listed`, 0. */
export async function listingPresenceOf(variantIds: readonly string[]): Promise<Map<string, VariantPresence>> {
  const ids = [...new Set(variantIds)];
  const statuses = new Map<string, ListingStatus[]>();
  for (const { variantId, status } of await currentListingStatuses(ids)) {
    statuses.set(variantId, [...(statuses.get(variantId) ?? []), status]);
  }
  return new Map(
    ids.map((id) => {
      const own = statuses.get(id) ?? [];
      return [id, { ...presenceOf(own), listingCount: own.length }];
    }),
  );
}

export interface ChannelCoverage {
  /** Gian hàng chưa `disconnected`, cũ trước (như readiness §18.10). */
  shops: { shopId: string; shopName: string; platform: string }[];
  /** Gian hàng mà SKU đã lên sàn hoặc đang đẩy; SKU không có thì không có trong Map. */
  listedShops: Map<string, Set<string>>;
}

/** Như readiness tính `listed`: listing đang duyệt, đang bán, đang ẩn trên sàn, hoặc đang đẩy. */
const COVERED: readonly ListingStatus[] = [...LISTED, 'pushing'];

/**
 * Độ phủ sàn cho danh sách sản phẩm (FE#464): hai câu cho cả trang (gian hàng, cặp SKU × gian hàng), không theo từng
 * sản phẩm. Tên gian hàng là tên hiển thị nếu có.
 */
export async function channelCoverageOf(variantIds: readonly string[]): Promise<ChannelCoverage> {
  const shops = (await listShopRows())
    .filter((s) => s.status !== 'disconnected')
    .map((s) => ({ shopId: s.id, shopName: s.displayName?.trim() || s.shopName, platform: s.platform }));
  const listedShops = new Map<string, Set<string>>();
  if (!shops.length) return { shops, listedShops };
  for (const { variantId, shopId } of await listingShopPairs([...new Set(variantIds)], COVERED)) {
    const set = listedShops.get(variantId) ?? new Set<string>();
    set.add(shopId);
    listedShops.set(variantId, set);
  }
  return { shops, listedShops };
}

/** SKU có listing (kể cả đã gỡ), ghép chờ duyệt, lần tính giá: catalog không xoá hẳn sản phẩm có SKU này (#204). */
export async function listingInUse(variantIds: readonly string[]): Promise<Set<string>> {
  return usedVariants([...new Set(variantIds)]);
}
