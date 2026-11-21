// Truy vấn cho gom lại dữ liệu cũ (#295, Documents/21 §18.8.4). Chạy trong `withCompany` của bên gọi.
import { and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import type { ListingRow } from './listings.ts';
import { listings, shopProducts, shops } from './schema.ts';

/**
 * Gian hàng mà các listing chưa gỡ của `variantIds` nằm ở hơn một sản phẩm sàn: `productCount` = số `external_product_id`
 * khác nhau. Chỉ trả gian hàng có > 1, bỏ gian hàng đã ngắt.
 */
export async function separateProductGroups(variantIds: readonly string[]): Promise<{ shopId: string; platform: string; productCount: number }[]> {
  if (!variantIds.length) return [];
  const count = sql<number>`count(distinct ${listings.externalProductId})::int`;
  return getDb()
    .select({ shopId: listings.shopId, platform: shops.platform, productCount: count })
    .from(listings)
    .innerJoin(shops, eq(shops.id, listings.shopId))
    .where(and(inArray(listings.variantId, [...variantIds]), ne(listings.status, 'delisted'), isNotNull(listings.externalProductId), ne(shops.status, 'disconnected')))
    .groupBy(listings.shopId, shops.platform)
    .having(sql`count(distinct ${listings.externalProductId}) > 1`)
    .orderBy(listings.shopId);
}

/** Listing chưa gỡ có mã sản phẩm sàn của các biến thể trên một gian hàng: những dòng đem gom. */
export async function regroupCandidates(shopId: string, variantIds: readonly string[]): Promise<ListingRow[]> {
  if (!variantIds.length) return [];
  return getDb()
    .select()
    .from(listings)
    .where(and(eq(listings.shopId, shopId), inArray(listings.variantId, [...variantIds]), ne(listings.status, 'delisted'), isNotNull(listings.externalProductId)))
    .orderBy(listings.createdAt, listings.id);
}

/** Listing của các biến thể trên gian hàng ở trạng thái `pushing` (lượt đẩy đang chạy). */
export async function pushingOfVariants(shopId: string, variantIds: readonly string[]): Promise<ListingRow[]> {
  if (!variantIds.length) return [];
  return getDb()
    .select()
    .from(listings)
    .where(and(eq(listings.shopId, shopId), inArray(listings.variantId, [...variantIds]), eq(listings.status, 'pushing')));
}

/** Dòng `app` `active` chưa có mã sàn của cha: lượt đẩy hay gom đang chạy. */
export async function openAppShopProduct(shopId: string, productId: string) {
  const [row] = await getDb()
    .select()
    .from(shopProducts)
    .where(
      and(
        eq(shopProducts.shopId, shopId),
        eq(shopProducts.productId, productId),
        eq(shopProducts.origin, 'app'),
        eq(shopProducts.status, 'active'),
        sql`${shopProducts.externalProductId} is null`,
      ),
    );
  return row;
}

/** Dòng `app` `active` của cha còn nợ việc gỡ sản phẩm lẻ cũ (`push_error.code = 'regroup_cleanup_failed'`). */
export async function cleanupPendingShopProduct(shopId: string, productId: string) {
  const [row] = await getDb()
    .select()
    .from(shopProducts)
    .where(
      and(
        eq(shopProducts.shopId, shopId),
        eq(shopProducts.productId, productId),
        eq(shopProducts.origin, 'app'),
        eq(shopProducts.status, 'active'),
        isNotNull(shopProducts.externalProductId),
        sql`${shopProducts.pushError} ->> 'code' = 'regroup_cleanup_failed'`,
      ),
    );
  return row;
}

/** Listing cũ (đã gỡ) mà các listing của sản phẩm sàn `shopProductId` thay: nguồn mã sản phẩm lẻ cần xoá trên sàn. */
export async function replacedListings(shopProductId: string): Promise<ListingRow[]> {
  const ids = (await getDb().select({ id: listings.replacesListingId }).from(listings).where(eq(listings.shopProductId, shopProductId))).flatMap((r) =>
    r.id ? [r.id] : [],
  );
  return ids.length ? getDb().select().from(listings).where(inArray(listings.id, ids)) : [];
}

/** Dòng `shop_products` `app` đang `delisted` mà listing chưa gỡ của các biến thể còn trỏ vào (khôi phục khi gom lỗi). */
export async function retiredAppShopProducts(shopId: string, variantIds: readonly string[]): Promise<string[]> {
  if (!variantIds.length) return [];
  const rows = await getDb()
    .selectDistinct({ id: shopProducts.id })
    .from(listings)
    .innerJoin(shopProducts, eq(shopProducts.id, listings.shopProductId))
    .where(
      and(
        eq(listings.shopId, shopId),
        inArray(listings.variantId, [...variantIds]),
        ne(listings.status, 'delisted'),
        eq(shopProducts.origin, 'app'),
        eq(shopProducts.status, 'delisted'),
      ),
    );
  return rows.map((r) => r.id);
}
