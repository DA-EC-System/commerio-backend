// Bản soạn trước nội dung sản phẩm mới (Documents/21 mục 16.3 "Bản soạn trước", 19 `purchase_product_drafts`).
import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { purchaseProductDrafts, purchaseRequests, suppliers } from './schema.ts';

export type DraftRow = typeof purchaseProductDrafts.$inferSelect;

/** Trạng thái đề nghị còn soạn được (draft … partially_received). */
export const OPEN_REQUEST_STATUSES = ['draft', 'pending_approval', 'changes_requested', 'approved', 'ordered', 'partially_received'] as const;

export async function findDraft(id: string): Promise<DraftRow | undefined> {
  const [row] = await getDb().select().from(purchaseProductDrafts).where(eq(purchaseProductDrafts.id, id));
  return row;
}

/** Khoá dòng bản soạn (sau khoá đề nghị nếu cùng giao dịch, theo thứ tự khoá của module). */
export async function lockDraft(id: string): Promise<DraftRow | undefined> {
  const [row] = await getDb().select().from(purchaseProductDrafts).where(eq(purchaseProductDrafts.id, id)).for('update');
  return row;
}

export function draftsOfRequests(requestIds: readonly string[]): Promise<DraftRow[]> {
  if (!requestIds.length) return Promise.resolve([]);
  return getDb()
    .select()
    .from(purchaseProductDrafts)
    .where(inArray(purchaseProductDrafts.requestId, [...requestIds]))
    .orderBy(asc(purchaseProductDrafts.createdAt), asc(purchaseProductDrafts.id));
}

export async function insertDrafts(companyId: string, requestId: string, parentKeys: readonly string[]): Promise<void> {
  if (!parentKeys.length) return;
  await getDb()
    .insert(purchaseProductDrafts)
    .values(parentKeys.map((parentKey) => ({ companyId, requestId, parentKey })))
    .onConflictDoNothing();
}

export async function deleteDrafts(ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  await getDb().delete(purchaseProductDrafts).where(inArray(purchaseProductDrafts.id, [...ids]));
}

/** Ghi khi `version` còn đúng; tăng `version`. Không trúng dòng thì `false`. */
export async function updateDraftIfVersion(id: string, version: number, set: Partial<typeof purchaseProductDrafts.$inferInsert>) {
  const rows = await getDb()
    .update(purchaseProductDrafts)
    .set({ ...set, version: sql`${purchaseProductDrafts.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(purchaseProductDrafts.id, id), eq(purchaseProductDrafts.version, version)))
    .returning({ id: purchaseProductDrafts.id });
  return rows.length > 0;
}

/** Ghi của hệ thống (bỏ tổ hợp mồ côi, đặt `product_id` khi chép): không xét `version`, vẫn tăng để FE đang sửa biết. */
export async function updateDraft(id: string, set: Partial<typeof purchaseProductDrafts.$inferInsert>): Promise<void> {
  await getDb()
    .update(purchaseProductDrafts)
    .set({ ...set, version: sql`${purchaseProductDrafts.version} + 1`, updatedAt: sql`now()` })
    .where(eq(purchaseProductDrafts.id, id));
}

/**
 * Danh sách cho `GET /purchasing/product-drafts` (21 mục 16.2): kèm số, trạng thái, ngày hẹn giao của đề nghị và tên NCC.
 * `pending`: chỉ bản chưa tạo sản phẩm của đề nghị chưa kết thúc. Mới nhất trước.
 */
export async function listDrafts(filter: { pending: boolean; page: number; pageSize: number }) {
  const where = filter.pending
    ? and(isNull(purchaseProductDrafts.productId), inArray(purchaseRequests.status, [...OPEN_REQUEST_STATUSES]))
    : undefined;
  const base = getDb()
    .select({
      draft: purchaseProductDrafts,
      requestNumber: purchaseRequests.number,
      requestStatus: purchaseRequests.status,
      expectedDeliveryDate: purchaseRequests.expectedDeliveryDate,
      supplierName: suppliers.name,
    })
    .from(purchaseProductDrafts)
    .innerJoin(purchaseRequests, eq(purchaseRequests.id, purchaseProductDrafts.requestId))
    .leftJoin(suppliers, eq(suppliers.id, purchaseRequests.supplierId))
    .where(where);
  const items = await base
    .orderBy(desc(purchaseProductDrafts.updatedAt), desc(purchaseProductDrafts.id))
    .limit(filter.pageSize)
    .offset((filter.page - 1) * filter.pageSize);
  const [total] = await getDb()
    .select({ n: count() })
    .from(purchaseProductDrafts)
    .innerJoin(purchaseRequests, eq(purchaseRequests.id, purchaseProductDrafts.requestId))
    .where(where);
  return { items, total: total?.n ?? 0 };
}

/** Đề nghị (số, trạng thái, ngày hẹn giao) và tên NCC của các bản soạn. */
export async function requestRefsOf(requestIds: readonly string[]) {
  if (!requestIds.length) return new Map<string, { number: string; status: string; expectedDeliveryDate: string | null; supplierName: string | null }>();
  const rows = await getDb()
    .select({
      id: purchaseRequests.id,
      number: purchaseRequests.number,
      status: purchaseRequests.status,
      expectedDeliveryDate: purchaseRequests.expectedDeliveryDate,
      supplierName: suppliers.name,
    })
    .from(purchaseRequests)
    .leftJoin(suppliers, eq(suppliers.id, purchaseRequests.supplierId))
    .where(inArray(purchaseRequests.id, [...requestIds]));
  return new Map(rows.map((r) => [r.id, r]));
}
