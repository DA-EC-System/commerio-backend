// Lần tính giá theo gian hàng (#225, bảng `price_calculations`; Documents/25 §6.2). Chạy trong `withCompany` của bên gọi.
// Mỗi (gian hàng, SKU) tối đa một bản `pending_confirm` (unique một phần); bản mới thay bản chờ cũ (`superseded`).
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { getDb, requireCompanyId } from '../../../../shared/db/client.ts';
import type { ListingRow } from './listings.ts';
import { listings, priceCalculations } from './schema.ts';

export type PriceCalculationRow = typeof priceCalculations.$inferSelect;
export type NewPriceCalculation = Omit<typeof priceCalculations.$inferInsert, 'id' | 'companyId' | 'status' | 'confirmedBy' | 'confirmedAt'>;

const pending = (shopId: string, variantId: string) =>
  and(eq(priceCalculations.shopId, shopId), eq(priceCalculations.variantId, variantId), eq(priceCalculations.status, 'pending_confirm'));

/**
 * Giá bộ lọc dùng cho lần đẩy đầu (#225 phần 2, trigger `push`): người bấm đẩy là người xác nhận, ghi thẳng `confirmed`;
 * lượt đẩy lên sàn xong thì `pushed`.
 */
export async function insertConfirmed(calc: NewPriceCalculation, by: string, at = new Date()): Promise<PriceCalculationRow> {
  const [row] = await getDb()
    .insert(priceCalculations)
    .values({ ...calc, companyId: requireCompanyId('insertConfirmed'), status: 'confirmed', confirmedBy: by, confirmedAt: at })
    .returning();
  return row!;
}

/** Bỏ bản chờ của SKU trên gian hàng (giá muốn bán bị xoá, cấu hình không còn tính được). */
export async function supersedePending(shopId: string, variantId: string): Promise<void> {
  await getDb().update(priceCalculations).set({ status: 'superseded', updatedAt: new Date() }).where(pending(shopId, variantId));
}

/**
 * Ghi bản chờ xác nhận mới, thay bản chờ cũ cùng (gian hàng, SKU). Khoá theo (gian hàng, SKU) tới hết giao dịch: hai
 * consumer tính lại cùng lúc (đổi giá muốn bán và kích hoạt phí) xếp hàng, không vấp unique `price_calculations_one_pending`.
 */
export async function insertPending(calc: NewPriceCalculation): Promise<PriceCalculationRow> {
  await getDb().execute(sql`select pg_advisory_xact_lock(hashtextextended(${`channel.price_calc:${calc.shopId}:${calc.variantId}`}, 0))`);
  await supersedePending(calc.shopId, calc.variantId);
  const [row] = await getDb()
    .insert(priceCalculations)
    .values({ ...calc, companyId: requireCompanyId('insertPending') })
    .returning();
  return row!;
}

/** Bản chờ của các SKU trên một gian hàng, theo biến thể. */
export async function pendingCalculations(shopId: string, variantIds: readonly string[]): Promise<Map<string, PriceCalculationRow>> {
  if (!variantIds.length) return new Map();
  const rows = await getDb()
    .select()
    .from(priceCalculations)
    .where(
      and(
        eq(priceCalculations.shopId, shopId),
        inArray(priceCalculations.variantId, [...variantIds]),
        eq(priceCalculations.status, 'pending_confirm'),
      ),
    );
  return new Map(rows.map((r) => [r.variantId, r]));
}

export async function findCalculations(ids: readonly string[]): Promise<Map<string, PriceCalculationRow>> {
  if (!ids.length) return new Map();
  const rows = await getDb().select().from(priceCalculations).where(inArray(priceCalculations.id, [...ids]));
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Xác nhận bản chờ: bản đang dùng trước đó của cùng (gian hàng, SKU) sang `superseded`. Trả null khi bản không còn chờ
 * (người khác đã xác nhận, hoặc có bản mới thay). CHECK `price_calculations_floor` chặn xác nhận bản dưới giá thấp nhất.
 */
export async function confirmPending(id: string, by: string, at = new Date()): Promise<PriceCalculationRow | null> {
  const [row] = await getDb()
    .update(priceCalculations)
    .set({ status: 'confirmed', confirmedBy: by, confirmedAt: at, updatedAt: at })
    .where(and(eq(priceCalculations.id, id), eq(priceCalculations.status, 'pending_confirm')))
    .returning();
  if (!row) return null;
  await getDb()
    .update(priceCalculations)
    .set({ status: 'superseded', updatedAt: at })
    .where(
      and(
        eq(priceCalculations.shopId, row.shopId),
        eq(priceCalculations.variantId, row.variantId),
        inArray(priceCalculations.status, ['confirmed', 'pushed']),
        ne(priceCalculations.id, id),
      ),
    );
  return row;
}

/** Sàn đã nhận giá của lần tính (lượt đồng bộ, lát 7). */
export async function markPushed(id: string): Promise<void> {
  await getDb()
    .update(priceCalculations)
    .set({ status: 'pushed', updatedAt: new Date() })
    .where(and(eq(priceCalculations.id, id), eq(priceCalculations.status, 'confirmed')));
}

/** Bản chờ xác nhận kèm listing chưa gỡ của nó, mới trước, phân trang (trang giá chờ, 21 §21.4). */
export async function pendingPage(
  shopId: string | undefined,
  page: number,
  pageSize: number,
): Promise<{ rows: { calc: PriceCalculationRow; listing: ListingRow }[]; total: number }> {
  const pc = priceCalculations;
  const rows = await getDb()
    .select({ calc: pc, listing: listings, total: sql<number>`(count(*) over ())::int` })
    .from(pc)
    .innerJoin(listings, and(eq(listings.shopId, pc.shopId), eq(listings.variantId, pc.variantId), ne(listings.status, 'delisted')))
    .where(and(eq(pc.status, 'pending_confirm'), shopId ? eq(pc.shopId, shopId) : undefined))
    .orderBy(desc(pc.createdAt), asc(pc.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return { rows: rows.map(({ calc, listing }) => ({ calc, listing })), total: rows[0]?.total ?? 0 };
}
