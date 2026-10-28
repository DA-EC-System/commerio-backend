// Listing (#104). Chạy trong `withCompany` của bên gọi.
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import type { ListingStatus } from '../domain/listing.ts';
import { listings } from './schema.ts';

export type ListingRow = typeof listings.$inferSelect;
export type ListingPatch = Partial<typeof listings.$inferInsert>;

export async function listListingRows(shopId: string, variantIds?: readonly string[]): Promise<ListingRow[]> {
  const byVariant = variantIds ? inArray(listings.variantId, [...variantIds]) : undefined;
  return getDb()
    .select()
    .from(listings)
    .where(and(eq(listings.shopId, shopId), byVariant));
}

export async function findListingRow(shopId: string, variantId: string): Promise<ListingRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(listings)
    .where(and(eq(listings.shopId, shopId), eq(listings.variantId, variantId)));
  return row;
}

export async function insertListing(values: typeof listings.$inferInsert): Promise<ListingRow> {
  const [row] = await getDb().insert(listings).values(values).returning();
  return row!;
}

/**
 * Sửa listing khi còn đúng `version` (và đúng trạng thái `from` khi chuyển trạng thái), tăng `version`.
 * Không trúng dòng thì `undefined`, bên gọi đọc lại để báo 409.
 */
export async function updateListing(
  id: string,
  expected: { version: number; status?: ListingStatus },
  patch: ListingPatch,
): Promise<ListingRow | undefined> {
  const [row] = await getDb()
    .update(listings)
    .set({ ...patch, version: sql`${listings.version} + 1`, updatedAt: sql`now()` })
    .where(
      and(
        eq(listings.id, id),
        eq(listings.version, expected.version),
        expected.status ? eq(listings.status, expected.status) : undefined,
      ),
    )
    .returning();
  return row;
}
