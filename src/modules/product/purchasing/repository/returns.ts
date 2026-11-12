import { and, asc, count, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { supplierReturnLines, supplierReturns } from './schema.ts';

// Phiếu trả NCC (B4). Hệ thống lập nháp từ hàng lỗi của phiếu nhận (#109), kiểm hàng về (#208); vòng đời ở #210.

/** Phiếu trả NCC nháp do hệ thống lập khi ghi sổ phiếu nhận có lỗi (`created_by` trống, spec #109 Q8). */
export async function insertDraftReturn(v: {
  companyId: string;
  number: string;
  supplierId: string | null;
  sourceId: string | null;
  source?: (typeof supplierReturns.$inferInsert)['source'];
  note?: string | null;
  createdBy?: string | null;
}): Promise<string> {
  const [row] = await getDb()
    .insert(supplierReturns)
    .values({ source: 'receipt_defect', ...v })
    .returning({ id: supplierReturns.id });
  return row!.id;
}

export async function insertReturnLines(
  companyId: string,
  returnId: string,
  lines: readonly { variantId: string; quantity: number; unitCost: string | null; sourceLineId: string | null }[],
): Promise<void> {
  if (!lines.length) return;
  await getDb()
    .insert(supplierReturnLines)
    .values(lines.map((l) => ({ ...l, companyId, returnId })));
}

/** Phiếu trả NCC sinh từ hàng lỗi của các phiếu nhận (`followUps` của phiếu nhận). */
export function returnsOfReceipts(receiptIds: readonly string[]) {
  return getDb()
    .select({ id: supplierReturns.id, number: supplierReturns.number, sourceId: supplierReturns.sourceId })
    .from(supplierReturns)
    .where(and(eq(supplierReturns.source, 'receipt_defect'), inArray(supplierReturns.sourceId, [...receiptIds])))
    .orderBy(asc(supplierReturns.createdAt), asc(supplierReturns.id));
}

/** Phiếu trả NCC sinh từ phiếu kho (`followUps` của kiểm hàng về, xuất huỷ bị từ chối; #208). */
export function returnsFromStockDocuments(docIds: readonly string[]) {
  if (!docIds.length) return Promise.resolve([] as { id: string; number: string; sourceId: string | null }[]);
  return getDb()
    .select({ id: supplierReturns.id, number: supplierReturns.number, sourceId: supplierReturns.sourceId })
    .from(supplierReturns)
    .where(and(inArray(supplierReturns.sourceId, [...docIds]), inArray(supplierReturns.source, ['quarantine', 'customer_return', 'write_off_rejected'])));
}

export type ReturnRow = typeof supplierReturns.$inferSelect;
export type ReturnLineRow = typeof supplierReturnLines.$inferSelect;

export async function findReturn(id: string, lock?: 'update'): Promise<ReturnRow | undefined> {
  const q = getDb().select().from(supplierReturns).where(eq(supplierReturns.id, id));
  const [row] = lock ? await q.for('update') : await q;
  return row;
}

export async function linesOfReturns(ids: readonly string[]): Promise<Map<string, ReturnLineRow[]>> {
  const out = new Map<string, ReturnLineRow[]>(ids.map((id) => [id, []]));
  if (!ids.length) return out;
  const rows = await getDb()
    .select()
    .from(supplierReturnLines)
    .where(inArray(supplierReturnLines.returnId, [...ids]))
    .orderBy(asc(supplierReturnLines.createdAt), asc(supplierReturnLines.id));
  for (const r of rows) out.get(r.returnId)!.push(r);
  return out;
}

/** Thay toàn bộ dòng của phiếu nháp. */
export async function replaceReturnLines(
  companyId: string,
  returnId: string,
  lines: readonly { variantId: string; quantity: number; unitCost: string | null; sourceLineId: string | null }[],
): Promise<void> {
  await getDb().delete(supplierReturnLines).where(eq(supplierReturnLines.returnId, returnId));
  const base = Date.now();
  if (lines.length) {
    await getDb()
      .insert(supplierReturnLines)
      .values(lines.map((l, i) => ({ ...l, companyId, returnId, createdAt: new Date(base + i) })));
  }
}

export async function updateReturn(id: string, version: number, values: Partial<typeof supplierReturns.$inferInsert>): Promise<ReturnRow | undefined> {
  const [row] = await getDb()
    .update(supplierReturns)
    .set({ ...values, version: sql`${supplierReturns.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(supplierReturns.id, id), eq(supplierReturns.version, version)))
    .returning();
  return row;
}

export async function listReturns(
  f: { status?: ReturnRow['status'] | undefined; supplierId?: string | undefined; search?: string | undefined },
  page: { limit: number; offset: number },
): Promise<{ rows: ReturnRow[]; total: number }> {
  const term = f.search?.trim();
  const where = and(
    f.status ? eq(supplierReturns.status, f.status) : undefined,
    f.supplierId ? eq(supplierReturns.supplierId, f.supplierId) : undefined,
    term ? or(ilike(supplierReturns.number, `%${term}%`), ilike(supplierReturns.note, `%${term}%`)) : undefined,
  );
  const [rows, [total]] = await Promise.all([
    getDb()
      .select()
      .from(supplierReturns)
      .where(where)
      .orderBy(desc(supplierReturns.createdAt), desc(supplierReturns.id))
      .limit(page.limit)
      .offset(page.offset),
    getDb().select({ n: count() }).from(supplierReturns).where(where),
  ]);
  return { rows, total: total?.n ?? 0 };
}
