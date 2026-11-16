import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
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
