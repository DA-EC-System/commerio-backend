// Đọc listing cho các cổng của catalog (#204): lý do chặn lưu trữ, hiện diện trên sàn.
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import type { ListingStatus } from '../domain/listing.ts';
import { listings } from './schema.ts';

/** Số listing đang đẩy lên sàn (`pushing`) theo SKU; SKU không có thì không có trong Map. Gọi trong `withCompany`. */
export async function pushingListingCounts(variantIds: readonly string[]): Promise<Map<string, number>> {
  if (!variantIds.length) return new Map();
  const rows = await getDb()
    .select({ variantId: listings.variantId, n: sql<number>`count(*)::int` })
    .from(listings)
    .where(and(eq(listings.status, 'pushing'), inArray(listings.variantId, [...variantIds])))
    .groupBy(listings.variantId);
  return new Map(rows.flatMap((r) => (r.variantId ? [[r.variantId, r.n] as const] : [])));
}

/** Trạng thái các listing chưa gỡ (`delisted`) của SKU, mọi gian hàng. Gọi trong `withCompany`. */
export async function currentListingStatuses(variantIds: readonly string[]): Promise<{ variantId: string; status: ListingStatus }[]> {
  if (!variantIds.length) return [];
  const rows = await getDb()
    .select({ variantId: listings.variantId, status: listings.status })
    .from(listings)
    .where(and(ne(listings.status, 'delisted'), inArray(listings.variantId, [...variantIds])));
  return rows.flatMap((r) => (r.variantId ? [{ variantId: r.variantId, status: r.status }] : []));
}
