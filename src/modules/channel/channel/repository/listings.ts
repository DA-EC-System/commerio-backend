// Listing (#104). Chạy trong `withCompany` của bên gọi.
import { and, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { pgError } from '../../../../shared/db/pg-error.ts';
import { type CategoryChange, type Marketplace, listings, shops } from './schema.ts';

export type ListingRow = typeof listings.$inferSelect;
export type ListingPatch = Partial<typeof listings.$inferInsert>;

export async function listListingRows(shopId: string, variantIds?: readonly string[]): Promise<ListingRow[]> {
  const byVariant = variantIds ? inArray(listings.variantId, [...variantIds]) : undefined;
  return getDb()
    .select()
    .from(listings)
    .where(and(eq(listings.shopId, shopId), byVariant));
}

/**
 * Cặp chuỗi giống nhau từ `min` theo `similarity()` của pg_trgm, điểm giảm dần (#198 §18.7.5). `left`, `right` là vị trí
 * trong hai mảng. Mảng truyền dạng jsonb vì drizzle tách mảng JS thành nhiều tham số. Câu chạy trong savepoint với
 * `statement_timeout` = `timeoutMs` (chạy xong đặt lại giá trị cũ); quá giờ hoặc hơn `maxRows` cặp qua ngưỡng thì trả
 * null, giao dịch của bên gọi vẫn dùng tiếp được.
 */
export async function nameSimilarities(
  left: readonly string[],
  right: readonly string[],
  min: number,
  timeoutMs: number,
  maxRows: number,
): Promise<{ left: number; right: number; score: number }[] | null> {
  try {
    return await getDb().transaction(async (tx) => {
      const { rows: prev } = await tx.execute<{ t: string }>(
        sql`select current_setting('statement_timeout') as t, set_config('statement_timeout', ${String(timeoutMs)}, true)`,
      );
      const { rows } = await tx.execute<{ li: number; ri: number; score: number }>(sql`
        select l.i::int - 1 as li, r.i::int - 1 as ri, similarity(l.t, r.t) as score
          from jsonb_array_elements_text(${JSON.stringify(left)}::jsonb) with ordinality l(t, i)
          cross join jsonb_array_elements_text(${JSON.stringify(right)}::jsonb) with ordinality r(t, i)
         where similarity(l.t, r.t) >= ${min}
         order by score desc, l.i, r.i
         limit ${maxRows + 1}`);
      await tx.execute(sql`select set_config('statement_timeout', ${prev[0]!.t}, true)`);
      if (rows.length > maxRows) return null;
      return rows.map((r) => ({ left: r.li, right: r.ri, score: Number(r.score) }));
    });
  } catch (err) {
    if (pgError(err).code === '57014') return null;
    throw err;
  }
}

/** Thứ tự chọn listing hiện hành của một SKU: dòng chưa gỡ trước, rồi dòng mới hơn (Documents/21 §18.6.4, #219). */
const CURRENT_FIRST = [sql`${listings.status} = 'delisted'`, desc(listings.createdAt)] as const;

/**
 * Listing hiện hành của biến thể trên gian hàng: dòng chưa `delisted` (unique, nhiều nhất một), không có thì dòng
 * `delisted` mới nhất, chưa từng có thì `undefined`.
 */
export async function findListingRow(shopId: string, variantId: string): Promise<ListingRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(listings)
    .where(and(eq(listings.shopId, shopId), eq(listings.variantId, variantId)))
    .orderBy(...CURRENT_FIRST)
    .limit(1);
  return row;
}

/** Một listing theo id (việc đẩy nền, #219); RLS của `withCompany` lọc công ty. */
export async function findListingById(id: string): Promise<ListingRow | undefined> {
  const [row] = await getDb().select().from(listings).where(eq(listings.id, id)).limit(1);
  return row;
}

/** Như `findListingRow` cho mọi biến thể của gian hàng: mỗi biến thể một dòng. */
export async function currentListingRows(shopId: string): Promise<ListingRow[]> {
  return getDb()
    .selectDistinctOn([listings.variantId])
    .from(listings)
    .where(and(eq(listings.shopId, shopId), isNotNull(listings.variantId)))
    .orderBy(listings.variantId, ...CURRENT_FIRST);
}

/** Như `findListingRow` cho một lô biến thể, một câu (be#564: kiểm trước khi đăng tới 200 biến thể). */
export async function currentListingRowsOf(shopId: string, variantIds: readonly string[]): Promise<Map<string, ListingRow>> {
  if (!variantIds.length) return new Map();
  const rows = await getDb()
    .selectDistinctOn([listings.variantId])
    .from(listings)
    .where(and(eq(listings.shopId, shopId), inArray(listings.variantId, [...variantIds])))
    .orderBy(listings.variantId, ...CURRENT_FIRST);
  return new Map(rows.map((r) => [r.variantId!, r]));
}

/**
 * Dòng "không quản tồn" hiện hành theo mã SKU sàn (không có biến thể nên `currentListingRows` không gồm): dòng chưa gỡ,
 * không có thì dòng gỡ mới nhất. Cho nối lại gian hàng (#220 đợt 2).
 */
export async function currentUnmanagedRows(shopId: string): Promise<ListingRow[]> {
  const rows = await getDb()
    .selectDistinctOn([listings.externalSkuId])
    .from(listings)
    .where(and(eq(listings.shopId, shopId), isNotNull(listings.externalSkuId)))
    .orderBy(listings.externalSkuId, ...CURRENT_FIRST);
  return rows.filter((r) => r.mode === 'unmanaged');
}

/**
 * Ghi mốc `create_attempted_at` = lúc của lần gọi `createProduct` gần nhất, ghi đè mỗi lần, ngay trước lời gọi (#399). Là
 * cột hệ thống như `push_attempts`: không tăng `version` vì lượt đẩy đang giữ version lúc đọc. Phải commit trước khi gọi
 * sàn để lần thử sau thấy mốc dù lần gọi này lỗi.
 */
export async function markCreateAttempted(id: string): Promise<void> {
  await getDb().update(listings).set({ createAttemptedAt: sql`now()` }).where(eq(listings.id, id));
}

/**
 * Category thật của listing trên sàn (#400, `external_category_id`): cột thông tin, không tăng `version` (L029: việc đẩy, ghép
 * đang giữ version lúc đọc). Trả id các dòng đã đổi giá trị.
 */
export async function setListingCategory(ids: readonly string[], externalCategoryId: string): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await getDb()
    .update(listings)
    .set({ externalCategoryId })
    .where(and(inArray(listings.id, [...ids]), sql`${listings.externalCategoryId} is distinct from ${externalCategoryId}`))
    .returning({ id: listings.id });
  return rows.map((r) => r.id);
}

/**
 * Biến thể có listing còn sản phẩm trên sàn (có mã SKU sàn, chưa `delisted`) ở các gian hàng cho trước (#223: gian hàng
 * "đơn chưa cập nhật"). Gọi trong `withCompany`.
 */
export async function variantsListedOn(shopIds: readonly string[]): Promise<{ variantId: string; shopId: string }[]> {
  if (!shopIds.length) return [];
  const rows = await getDb()
    .selectDistinct({ variantId: listings.variantId, shopId: listings.shopId })
    .from(listings)
    .where(
      and(
        inArray(listings.shopId, [...shopIds]),
        isNotNull(listings.variantId),
        isNotNull(listings.externalSkuId),
        ne(listings.status, 'delisted'),
      ),
    );
  return rows.map((r) => ({ variantId: r.variantId!, shopId: r.shopId }));
}

/**
 * Listing chưa gỡ của SKU sàn trên gian hàng (unique `listings_shop_external_sku_uq`, nhiều nhất một). `lock`: khoá dòng
 * (`FOR UPDATE`) tới hết giao dịch của bên gọi, để việc đẩy tồn, giá (ghi qua `listing-writes`) chờ thay vì đổi `version`
 * giữa lúc đọc và lúc ghi (#411).
 */
export async function findListingByExternalSku(
  shopId: string,
  externalSkuId: string,
  opts: { lock?: boolean } = {},
): Promise<ListingRow | undefined> {
  const query = getDb()
    .select()
    .from(listings)
    .where(and(eq(listings.shopId, shopId), eq(listings.externalSkuId, externalSkuId), sql`${listings.status} <> 'delisted'`))
    .limit(1);
  const [row] = opts.lock ? await query.for('update') : await query;
  return row;
}

/** Listing lỗi đẩy đang chờ CEO duyệt ghép SKU sàn này (#346). */
export async function findListingByPendingExternalSku(shopId: string, externalSkuId: string): Promise<ListingRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(listings)
    .where(and(eq(listings.shopId, shopId), eq(listings.pendingExternalSkuId, externalSkuId)))
    .limit(1);
  return row;
}

/** Listing chưa gỡ của gian hàng, mọi chế độ ghép (kể cả "không quản tồn", `variant_id` trống). */
export async function liveListingRows(shopId: string): Promise<ListingRow[]> {
  return getDb()
    .select()
    .from(listings)
    .where(and(eq(listings.shopId, shopId), sql`${listings.status} <> 'delisted'`));
}

/** Xoá dòng khi còn đúng `version`; trả số dòng xoá (#220: từ chối ghép của dòng tạo ra chỉ để chờ duyệt). */
export async function deleteListing(id: string, version: number): Promise<number> {
  const rows = await getDb()
    .delete(listings)
    .where(and(eq(listings.id, id), eq(listings.version, version)))
    .returning({ id: listings.id });
  return rows.length;
}

/** Gian hàng có listing `live`, `hidden` của biến thể (ẩn, hiện theo trạng thái SKU, #224). */
export async function shopsShowingVariant(variantId: string): Promise<string[]> {
  const rows = await getDb()
    .selectDistinct({ shopId: listings.shopId })
    .from(listings)
    .where(and(eq(listings.variantId, variantId), inArray(listings.status, ['live', 'hidden'])));
  return rows.map((r) => r.shopId);
}

/** Các listing theo id (việc đổi category, #467); RLS của `withCompany` lọc công ty. */
export async function listingsByIds(ids: readonly string[]): Promise<ListingRow[]> {
  if (!ids.length) return [];
  return getDb().select().from(listings).where(inArray(listings.id, [...ids])).orderBy(listings.id);
}

/** Listing chưa gỡ của các biến thể trên mọi gian hàng của sàn (`apply-category`, #467). Gọi trong `withCompany`. */
export async function platformListingRows(platform: Marketplace, variantIds: readonly string[]): Promise<ListingRow[]> {
  if (!variantIds.length) return [];
  const rows = await getDb()
    .select({ listing: listings })
    .from(listings)
    .innerJoin(shops, eq(shops.id, listings.shopId))
    .where(and(eq(shops.platform, platform), inArray(listings.variantId, [...variantIds]), ne(listings.status, 'delisted')))
    .orderBy(listings.shopId, listings.id);
  return rows.map((r) => r.listing);
}

const isQueued = sql`${listings.categoryChange} ->> 'status' = 'queued'`;

/**
 * Xếp lượt đổi category (#467): ghi `category_change = queued` cho các listing chưa có lượt `queued` và chưa gỡ, tăng
 * `version`. Trả số dòng đã ghi; bên gọi so với số id để biết request khác vừa xếp trước (rollback, 409).
 */
export async function markCategoryQueued(ids: readonly string[], change: CategoryChange): Promise<number> {
  if (!ids.length) return 0;
  const rows = await getDb()
    .update(listings)
    .set({ categoryChange: change, version: sql`${listings.version} + 1`, updatedAt: sql`now()` })
    .where(
      and(
        inArray(listings.id, [...ids]),
        ne(listings.status, 'delisted'),
        sql`(${listings.categoryChange} is null or ${listings.categoryChange} ->> 'status' <> 'queued')`,
      ),
    )
    .returning({ id: listings.id });
  return rows.length;
}

/**
 * Ghi lại lượt đổi category đang `queued` (lỗi tạm: số lần thử, mã, câu), không tăng `version` (cột hệ thống như
 * `create_attempted_at`; L029). Dòng không còn `queued` (đã gỡ, đã xong) thì bỏ. Trả id đã ghi.
 */
export async function updateQueuedCategoryChange(ids: readonly string[], change: CategoryChange): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await getDb()
    .update(listings)
    .set({ categoryChange: change })
    .where(and(inArray(listings.id, [...ids]), isQueued))
    .returning({ id: listings.id });
  return rows.map((r) => r.id);
}

/**
 * Kết thúc lượt đổi category đang `queued` (#467), tăng `version`: `change` null là sàn nhận và không lệch, còn lại
 * `failed`/`mismatch`. `revision`: sàn đã nhận bản sửa nên ghi bản sửa đang duyệt (`revision_status = 'auditing'`) như
 * `update_content`, chỉ ở trạng thái còn giữ bản sửa (CHECK `listings_revision`). Trả các dòng đã ghi.
 */
export async function finishCategoryChange(
  ids: readonly string[],
  change: CategoryChange | null,
  revision: boolean,
  externalCategoryId: string | null = null,
): Promise<ListingRow[]> {
  if (!ids.length) return [];
  const keeps = sql`${listings.status} in ('live', 'hidden', 'platform_hold')`;
  return getDb()
    .update(listings)
    .set({
      categoryChange: change,
      ...(externalCategoryId && { externalCategoryId }),
      ...(revision && {
        revisionStatus: sql`case when ${keeps} then 'auditing' else ${listings.revisionStatus} end::channel.listing_revision_status`,
        revisionRejectReason: sql`case when ${keeps} then null else ${listings.revisionRejectReason} end`,
        revisionAt: sql`case when ${keeps} then now() else ${listings.revisionAt} end`,
      }),
      version: sql`${listings.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(and(inArray(listings.id, [...ids]), isQueued))
    .returning();
}

/**
 * Mọi listing chưa gỡ của các sản phẩm sàn `(shopId, externalProductId)` trong công ty, kể cả biến thể của sản phẩm khác
 * trong app (`apply-category`, #467: Edit Product ghi đè cả sản phẩm sàn). Gọi trong `withCompany`.
 */
export async function remoteProductListings(pairs: readonly { shopId: string; externalProductId: string }[]): Promise<ListingRow[]> {
  if (!pairs.length) return [];
  const any = or(...pairs.map((p) => and(eq(listings.shopId, p.shopId), eq(listings.externalProductId, p.externalProductId))));
  return getDb().select().from(listings).where(and(any, ne(listings.status, 'delisted'))).orderBy(listings.shopId, listings.id);
}

/**
 * Đánh `failed` các lượt đổi category `queued` có `at` trước `before` (kẹt vì việc rơi), không tăng `version`. Nếu `ids`
 * không rỗng thì chỉ xét các listing này. Trả id đã ghi.
 */
export async function failStaleCategoryChanges(before: Date, message: string, ids?: readonly string[]): Promise<string[]> {
  if (ids && !ids.length) return [];
  const rows = await getDb()
    .update(listings)
    .set({
      categoryChange: sql`jsonb_set(jsonb_set(jsonb_set(${listings.categoryChange}, '{status}', '"failed"'), '{code}', '"marketplace_unavailable"'), '{message}', to_jsonb(${message}::text))`,
    })
    .where(
      and(
        ids ? inArray(listings.id, [...ids]) : undefined,
        isQueued,
        sql`(${listings.categoryChange} ->> 'at')::timestamptz < ${before.toISOString()}::timestamptz`,
      ),
    )
    .returning({ id: listings.id });
  return rows.map((r) => r.id);
}

/** Xoá `category_change` `failed`/`mismatch` của các listing (sàn đã ở đúng category đích, #467). */
export async function clearResolvedCategoryChange(ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  await getDb()
    .update(listings)
    .set({ categoryChange: null })
    .where(and(inArray(listings.id, [...ids]), sql`${listings.categoryChange} ->> 'status' in ('failed', 'mismatch')`));
}

/** Listing `pushing` của một sản phẩm sàn chưa có SKU sàn: các phân loại của lượt đẩy theo cha (#295). */
export async function pushingRowsOfShopProduct(shopProductId: string): Promise<ListingRow[]> {
  return getDb()
    .select()
    .from(listings)
    .where(and(eq(listings.shopProductId, shopProductId), eq(listings.status, 'pushing'), isNull(listings.externalSkuId)))
    .orderBy(listings.createdAt, listings.id);
}

/** Listing chưa gỡ của một sản phẩm sàn (#295): các phân loại cùng sản phẩm, để áp thay đổi của cả sản phẩm. */
export async function listingsOfShopProduct(shopProductId: string): Promise<ListingRow[]> {
  return getDb()
    .select()
    .from(listings)
    .where(and(eq(listings.shopProductId, shopProductId), ne(listings.status, 'delisted')))
    .orderBy(listings.createdAt, listings.id);
}
