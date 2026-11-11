// Listing (#104). Chạy trong `withCompany` của bên gọi.
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { pgError } from '../../../../shared/db/pg-error.ts';
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

/** Như `findListingRow` cho mọi biến thể của gian hàng: mỗi biến thể một dòng. */
export async function currentListingRows(shopId: string): Promise<ListingRow[]> {
  return getDb()
    .selectDistinctOn([listings.variantId])
    .from(listings)
    .where(and(eq(listings.shopId, shopId), isNotNull(listings.variantId)))
    .orderBy(listings.variantId, ...CURRENT_FIRST);
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

/**
 * Tồn trên sàn vừa bị đẩy về 0 mà ngắt bị chặn (#207): như `markStockPendingRows`, thêm `platform_stock = 0`.
 */
export async function markStockPendingIds(ids: readonly string[]): Promise<void> {
  await getDb()
    .update(listings)
    .set({ ...stockPending(), platformStock: 0 })
    .where(inArray(listings.id, [...ids]));
}

/** `stock_sync = pending`, tăng `version` để lượt đồng bộ đang chờ sàn không ghi `synced` đè lên lần đánh dấu (#222). */
function stockPending() {
  return { stockSync: 'pending' as const, version: sql`${listings.version} + 1`, updatedAt: sql`now()` };
}

/**
 * Listing của biến thể ở các trạng thái cho trước chuyển `stock_sync = pending`. Tăng `version` để lượt đồng bộ đang
 * chờ sàn không ghi `synced` đè lên lần đánh dấu này (#222).
 */
export async function markStockPendingRows(variantId: string, statuses: readonly ListingStatus[]): Promise<void> {
  await getDb()
    .update(listings)
    .set(stockPending())
    .where(and(eq(listings.variantId, variantId), inArray(listings.status, [...statuses])));
}
