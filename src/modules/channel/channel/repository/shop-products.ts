// Sản phẩm sàn theo gian hàng (#295, Documents/19 câu chốt Q1, 21 §18.8.4). Chạy trong `withCompany` của bên gọi.
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import type { SyncError } from './schema.ts';
import { shopProducts } from './schema.ts';

export type ShopProductRow = typeof shopProducts.$inferSelect;

/**
 * Dòng `active` của sản phẩm sàn `(shopId, externalProductId)`, chưa có thì tạo dòng `match` (sản phẩm sàn có sẵn, ghép SKU,
 * dữ liệu trước #295). Có dòng `app` cùng mã thì trả dòng đó. Đua nhau thì unique một phần giữ một dòng.
 */
export async function ensureShopProduct(companyId: string, shopId: string, externalProductId: string): Promise<string> {
  const [row] = await getDb()
    .insert(shopProducts)
    .values({ companyId, shopId, externalProductId, origin: 'match' })
    .onConflictDoUpdate({
      target: [shopProducts.shopId, shopProducts.externalProductId],
      targetWhere: sql`${shopProducts.externalProductId} is not null and ${shopProducts.status} = 'active'`,
      set: { updatedAt: sql`now()` },
    })
    .returning({ id: shopProducts.id });
  return row!.id;
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
