// Dữ liệu gốc đơn sàn và mốc kéo đơn (#105). Chạy trong `withCompany` của bên gọi.
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { getDb, requireCompanyId } from '../../../../shared/db/client.ts';
import { listings, rawOrders, shops } from './schema.ts';

/** `updated_at` của sàn đã lưu ở lần kéo trước, theo mã đơn sàn. */
export async function findRawOrderTimes(shopId: string, externalOrderIds: readonly string[]): Promise<Map<string, Date>> {
  if (!externalOrderIds.length) return new Map();
  const rows = await getDb()
    .select({ id: rawOrders.externalOrderId, at: rawOrders.externalUpdateTime })
    .from(rawOrders)
    .where(and(eq(rawOrders.shopId, shopId), inArray(rawOrders.externalOrderId, [...externalOrderIds])));
  return new Map(rows.filter((r) => r.at).map((r) => [r.id, r.at!]));
}

export async function saveRawOrder(input: {
  shopId: string;
  orderId: string;
  externalOrderId: string;
  externalStatus: string;
  payload: unknown;
  externalUpdateTime: Date;
}): Promise<void> {
  const { shopId, externalOrderId, ...rest } = input;
  await getDb()
    .insert(rawOrders)
    .values({ companyId: requireCompanyId('saveRawOrder'), shopId, externalOrderId, ...rest })
    .onConflictDoUpdate({
      target: [rawOrders.shopId, rawOrders.externalOrderId],
      set: { ...rest, version: sql`${rawOrders.version} + 1`, updatedAt: sql`now()` },
    });
}

/** Biến thể đã ghép theo SellerSku của gian hàng (listing, #104). */
export async function variantsBySellerSku(shopId: string, sellerSkus: readonly string[]): Promise<Map<string, string>> {
  if (!sellerSkus.length) return new Map();
  const rows = await getDb()
    .select({ sku: listings.sellerSku, variantId: listings.variantId })
    .from(listings)
    .where(and(eq(listings.shopId, shopId), inArray(listings.sellerSku, [...sellerSkus]), isNotNull(listings.variantId)));
  return new Map(rows.map((r) => [r.sku!, r.variantId!]));
}

/** Đẩy mốc kéo đơn, không lùi (lần kéo tay và việc nền có thể chạy cùng lúc). */
export async function advanceOrderCursor(shopId: string, at: Date): Promise<void> {
  await getDb()
    .update(shops)
    .set({ lastOrderSyncAt: sql`greatest(coalesce(${shops.lastOrderSyncAt}, ${at}), ${at})` })
    .where(eq(shops.id, shopId));
}
