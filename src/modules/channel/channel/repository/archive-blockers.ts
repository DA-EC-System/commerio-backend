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

/**
 * SKU đã dùng (#204 spec mục 6, chặn xoá hẳn sản phẩm), một câu cho cả lô; chứng từ ở mọi trạng thái, kể cả đã huỷ.
 * SKU không có thì không có trong Set. Gọi trong `withCompany`.
 */
export async function usedVariants(variantIds: readonly string[]): Promise<Set<string>> {
  if (!variantIds.length) return new Set();
  const ids = [...variantIds];
  // Listing kể cả đã gỡ; ghép chờ CEO duyệt; lần tính giá theo sàn.
  const { rows } = await getDb().execute<{ id: string }>(sql`
    select variant_id as id from channel.listings where variant_id in ${ids}
    union select pending_variant_id from channel.listings where pending_variant_id in ${ids}
    union select variant_id from channel.price_calculations where variant_id in ${ids}`);
  return new Set(rows.map((r) => r.id));
}
