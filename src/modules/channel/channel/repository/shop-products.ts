// Sản phẩm sàn theo gian hàng (#295, Documents/19 câu chốt Q1, 21 §18.8.4). Chạy trong `withCompany` của bên gọi. Dòng
// `match` do trigger `listings_attach_shop_product` tạo khi listing có mã sản phẩm sàn (migration `*_san-pham-san-du-lieu`).
import { and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import type { SyncError } from './schema.ts';
import { listings, shopProducts } from './schema.ts';

export type ShopProductRow = typeof shopProducts.$inferSelect;

/**
 * Dòng `match` đang `active` mà listing chưa gỡ của các biến thể `variantIds` (anh em cùng sản phẩm cha) trên gian hàng trỏ
 * tới: sản phẩm người bán đã có trên sàn, ghép vào app (KB3). Dòng `match` không có `product_id` (CHECK
 * `shop_products_origin`), nên tìm qua listing. Khoá `FOR UPDATE` khi `lock`.
 */
export async function matchShopProductsOf(shopId: string, variantIds: readonly string[], opts: { lock?: boolean } = {}): Promise<ShopProductRow[]> {
  if (!variantIds.length) return [];
  const ids = getDb()
    .selectDistinct({ id: listings.shopProductId })
    .from(listings)
    .where(and(eq(listings.shopId, shopId), inArray(listings.variantId, [...variantIds]), isNotNull(listings.shopProductId), ne(listings.status, 'delisted')));
  const query = getDb()
    .select()
    .from(shopProducts)
    .where(and(inArray(shopProducts.id, ids), eq(shopProducts.origin, 'match'), eq(shopProducts.status, 'active'), isNotNull(shopProducts.externalProductId)))
    .orderBy(shopProducts.id);
  return opts.lock ? query.for('update') : query;
}

/** Dòng `app` đang `active` của sản phẩm cha trên gian hàng (một cha một sản phẩm sàn), khoá `FOR UPDATE` khi `lock`. */
export async function findAppShopProduct(shopId: string, productId: string, opts: { lock?: boolean } = {}): Promise<ShopProductRow | undefined> {
  const query = getDb()
    .select()
    .from(shopProducts)
    .where(and(eq(shopProducts.shopId, shopId), eq(shopProducts.productId, productId), eq(shopProducts.origin, 'app'), eq(shopProducts.status, 'active')));
  const [row] = await (opts.lock ? query.for('update') : query);
  return row;
}

export async function findShopProduct(id: string): Promise<ShopProductRow | undefined> {
  const [row] = await getDb().select().from(shopProducts).where(eq(shopProducts.id, id));
  return row;
}

export async function shopProductsByIds(ids: readonly string[]): Promise<ShopProductRow[]> {
  if (!ids.length) return [];
  return getDb().select().from(shopProducts).where(inArray(shopProducts.id, [...ids]));
}

/** Dòng `app` mới cho lần đẩy đầu của cha, chưa có mã sàn. Đụng unique (lượt khác vừa tạo) thì ném lỗi của PostgreSQL. */
export async function insertAppShopProduct(companyId: string, shopId: string, productId: string): Promise<ShopProductRow> {
  const [row] = await getDb().insert(shopProducts).values({ companyId, shopId, productId, origin: 'app' }).returning();
  return row!;
}

/** Ghi mã sàn vừa tạo lên dòng `app` (chỉ khi còn trống), xoá lỗi lần trước. */
export async function setShopProductExternal(id: string, externalProductId: string): Promise<void> {
  await getDb()
    .update(shopProducts)
    .set({ externalProductId, pushError: null, version: sql`${shopProducts.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(shopProducts.id, id), sql`${shopProducts.externalProductId} is null`));
}

export async function setShopProductError(id: string, pushError: SyncError | null): Promise<void> {
  await getDb().update(shopProducts).set({ pushError, updatedAt: sql`now()` }).where(eq(shopProducts.id, id));
}

export async function setShopProductStatus(id: string, status: 'active' | 'delisted' | 'failed', pushError?: SyncError | null): Promise<void> {
  await getDb()
    .update(shopProducts)
    .set({ status, ...(pushError !== undefined && { pushError }), version: sql`${shopProducts.version} + 1`, updatedAt: sql`now()` })
    .where(eq(shopProducts.id, id));
}

/** Mốc lượt đẩy mới của dòng `app` (khoá chống tạo trùng, việc cũ thấy mốc khác thì bỏ). */
export async function setShopProductPushStarted(id: string, at: Date): Promise<void> {
  await getDb().update(shopProducts).set({ pushStartedAt: at, pushError: null, updatedAt: sql`now()` }).where(eq(shopProducts.id, id));
}

/** Ghi lúc gọi tạo (commit trước lời gọi sàn, như `markCreateAttempted` của listing, #399). */
export async function markShopProductCreateAttempted(id: string, at: Date | null): Promise<void> {
  await getDb().update(shopProducts).set({ createAttemptedAt: at }).where(eq(shopProducts.id, id));
}

/**
 * Bắt đầu một lượt gom lại dữ liệu cũ (#295, 21 §18.8.4): dòng `app` mới cho lượt, đặt mốc `startedAt`. Đã có dòng `app`
 * `active` chưa có mã sàn: cùng mốc thì là lượt thử lại, dùng lại; khác mốc thì lượt khác đang giữ, trả `undefined`. Có dòng
 * `app` `active` đã có mã sàn (cha từng đẩy bằng app) thì chuyển `delisted` để nhường unique một phần; trả kèm id để lỗi thì
 * khôi phục. Gọi trong `withCompany`, một giao dịch.
 */
export async function startRegroupShopProduct(
  companyId: string,
  shopId: string,
  productId: string,
  startedAt: Date,
): Promise<{ row: ShopProductRow; retired: string[] } | undefined> {
  const current = await findAppShopProduct(shopId, productId, { lock: true });
  if (current && !current.externalProductId) {
    if (current.pushStartedAt?.getTime() !== startedAt.getTime()) return undefined;
    return { row: current, retired: [] };
  }
  const retired: string[] = [];
  if (current) {
    await setShopProductStatus(current.id, 'delisted');
    retired.push(current.id);
  }
  const row = await insertAppShopProduct(companyId, shopId, productId);
  await setShopProductPushStarted(row.id, startedAt);
  return { row: { ...row, pushStartedAt: startedAt }, retired };
}
