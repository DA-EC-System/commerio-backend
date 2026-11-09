// Phiếu kho trong `stock_documents`. Phiếu do hệ thống lập theo kiện hoặc yêu cầu trả (spec #206 mục 5.3): phiếu xuất
// `shipment`, phiếu đảo `shipment_reversal`, phiếu kiểm hàng hoàn `return_inspection`. Phiếu kho có duyệt (#208;
// Documents/21 mục 15.2, 15.3). Mọi hàm chạy trong `withCompany` của bên gọi: RLS chỉ cho thấy phiếu của công ty đang chọn.
import { and, asc, count, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import type { DocumentRef, SystemDocKind } from '../domain/documents.ts';
import { companyOfTransaction } from './levels.ts';
import { stockDocumentLines, stockDocuments } from './schema.ts';

export type DocumentSourceType = 'package' | 'return_request';

export interface NewSystemDocument {
  number: string;
  kind: SystemDocKind;
  status: 'posted' | 'draft';
  sourceType: DocumentSourceType;
  sourceId: string;
  /** Người lập; trống khi sàn hoặc hệ thống lập. Phiếu `posted` ghi luôn làm người ghi sổ. */
  actorId: string | null;
  note: string | null;
  /** Kiểm hàng hoàn: mã chứng từ nguồn, đơn, gian hàng do bên gọi đưa qua `meta` của `receiveBack` (#208). */
  sourceNumber?: string | null;
  orderId?: string | null;
  shopId?: string | null;
}

export async function insertDocument(d: NewSystemDocument): Promise<string> {
  const posted = d.status === 'posted';
  const [row] = await getDb()
    .insert(stockDocuments)
    .values({
      companyId: companyOfTransaction(),
      number: d.number,
      kind: d.kind,
      status: d.status,
      sourceType: d.sourceType,
      sourceId: d.sourceId,
      note: d.note,
      sourceNumber: d.sourceNumber ?? null,
      orderId: d.orderId ?? null,
      shopId: d.shopId ?? null,
      createdBy: d.actorId,
      postedBy: posted ? d.actorId : null,
      postedAt: posted ? sql`now()` : null,
      // Giờ lúc chèn, sau khi đã khoá dòng tồn, không phải giờ đầu giao dịch: lượt bàn giao sắp theo cột này (Q22).
      createdAt: sql`clock_timestamp()`,
    })
    .returning({ id: stockDocuments.id });
  return row!.id;
}

export interface NewDocumentLine {
  variantId: string;
  quantity: number | null;
  expectedQty: number | null;
  unitCost: string | null;
  /** Id dòng kiện của phiếu xuất (Q12); trống với loại khác. */
  sourceLineId: string | null;
}

export interface InsertedDocumentLine {
  id: string;
  variantId: string;
  sourceLineId: string | null;
}

/** Chèn dòng phiếu, trả id từng dòng kèm SKU và dòng nguồn để thẻ kho trỏ về. */
export async function insertDocumentLines(documentId: string, lines: readonly NewDocumentLine[]): Promise<InsertedDocumentLine[]> {
  if (!lines.length) return [];
  const companyId = companyOfTransaction();
  return getDb()
    .insert(stockDocumentLines)
    .values(lines.map((l) => ({ companyId, documentId, ...l })))
    .returning({ id: stockDocumentLines.id, variantId: stockDocumentLines.variantId, sourceLineId: stockDocumentLines.sourceLineId });
}

export interface ShipmentDoc {
  id: string;
  number: string;
  kind: 'shipment' | 'shipment_reversal';
  lines: { variantId: string; quantity: number; unitCost: string; sourceLineId: string | null }[];
}

/** Mọi phiếu xuất, phiếu đảo của kiện kèm dòng, cũ trước (theo `created_at`, Q22). */
export async function packageShipments(packageId: string): Promise<ShipmentDoc[]> {
  const companyId = companyOfTransaction();
  const docs = await getDb()
    .select({ id: stockDocuments.id, number: stockDocuments.number, kind: stockDocuments.kind })
    .from(stockDocuments)
    .where(
      and(
        eq(stockDocuments.companyId, companyId),
        eq(stockDocuments.sourceType, 'package'),
        eq(stockDocuments.sourceId, packageId),
        inArray(stockDocuments.kind, ['shipment', 'shipment_reversal']),
      ),
    )
    .orderBy(asc(stockDocuments.createdAt), asc(stockDocuments.id));
  if (!docs.length) return [];
  const lines = await getDb()
    .select({
      documentId: stockDocumentLines.documentId,
      variantId: stockDocumentLines.variantId,
      quantity: stockDocumentLines.quantity,
      unitCost: stockDocumentLines.unitCost,
      sourceLineId: stockDocumentLines.sourceLineId,
    })
    .from(stockDocumentLines)
    .where(
      and(
        eq(stockDocumentLines.companyId, companyId),
        inArray(
          stockDocumentLines.documentId,
          docs.map((d) => d.id),
        ),
      ),
    );
  return docs.map((d) => ({
    id: d.id,
    number: d.number,
    kind: d.kind as ShipmentDoc['kind'],
    // Dòng phiếu xuất, phiếu đảo luôn có `quantity` và `unit_cost` (spec #206 mục 5.3).
    lines: lines
      .filter((l) => l.documentId === d.id)
      .map((l) => ({ variantId: l.variantId, quantity: l.quantity!, unitCost: l.unitCost!, sourceLineId: l.sourceLineId })),
  }));
}

/** Phiếu kiểm hàng hoàn đã lập cho một nguồn (kiện hoặc yêu cầu trả), nếu có. */
export async function returnInspectionOf(sourceType: DocumentSourceType, sourceId: string): Promise<DocumentRef | null> {
  const [row] = await getDb()
    .select({ documentId: stockDocuments.id, number: stockDocuments.number })
    .from(stockDocuments)
    .where(
      and(
        eq(stockDocuments.companyId, companyOfTransaction()),
        eq(stockDocuments.kind, 'return_inspection'),
        eq(stockDocuments.sourceType, sourceType),
        eq(stockDocuments.sourceId, sourceId),
      ),
    )
    .orderBy(asc(stockDocuments.createdAt))
    .limit(1);
  return row ?? null;
}

// ---------- Phiếu kho có duyệt (#208) ----------

export type DocRow = typeof stockDocuments.$inferSelect;
export type DocLineRow = typeof stockDocumentLines.$inferSelect;
export type NewDocLine = Omit<typeof stockDocumentLines.$inferInsert, 'companyId' | 'documentId'>;

export async function insertDoc(values: typeof stockDocuments.$inferInsert): Promise<DocRow> {
  const [row] = await getDb().insert(stockDocuments).values(values).returning();
  return row!;
}

/** Phiếu loại `kind` lập sớm nhất từ một chứng từ nguồn (`receiveBack` gọi lại cùng nguồn trả phiếu cũ). */
export async function findDocBySource(
  kind: DocRow['kind'],
  sourceType: string,
  sourceId: string,
): Promise<Pick<DocRow, 'id' | 'number'> | undefined> {
  const [row] = await getDb()
    .select({ id: stockDocuments.id, number: stockDocuments.number })
    .from(stockDocuments)
    .where(and(eq(stockDocuments.kind, kind), eq(stockDocuments.sourceType, sourceType), eq(stockDocuments.sourceId, sourceId)))
    .orderBy(asc(stockDocuments.createdAt))
    .limit(1);
  return row;
}

export async function insertDocLines(companyId: string, documentId: string, lines: readonly NewDocLine[]): Promise<void> {
  if (!lines.length) return;
  // Cùng giao dịch thì `now()` như nhau: lệch từng mili giây để đọc ra đúng thứ tự người dùng nhập
  const base = Date.now();
  await getDb()
    .insert(stockDocumentLines)
    .values(lines.map((l, i) => ({ ...l, companyId, documentId, createdAt: new Date(base + i) })));
}

/** Thay toàn bộ dòng của phiếu nháp (PUT gửi đủ dòng). */
export async function replaceDocLines(companyId: string, documentId: string, lines: readonly NewDocLine[]): Promise<void> {
  await getDb().delete(stockDocumentLines).where(eq(stockDocumentLines.documentId, documentId));
  await insertDocLines(companyId, documentId, lines);
}

/** Giá vốn chốt lúc ghi sổ trên từng dòng. */
export async function setLineCosts(costs: ReadonlyMap<string, string>): Promise<void> {
  for (const [lineId, unitCost] of costs) {
    await getDb().update(stockDocumentLines).set({ unitCost }).where(eq(stockDocumentLines.id, lineId));
  }
}

export async function findDoc(id: string, lock?: 'update'): Promise<DocRow | undefined> {
  const q = getDb().select().from(stockDocuments).where(eq(stockDocuments.id, id));
  const [row] = lock ? await q.for('update') : await q;
  return row;
}

/** Dòng của các phiếu, theo thứ tự lập. */
export async function linesOfDocs(ids: readonly string[]): Promise<Map<string, DocLineRow[]>> {
  const out = new Map<string, DocLineRow[]>(ids.map((id) => [id, []]));
  if (!ids.length) return out;
  const rows = await getDb()
    .select()
    .from(stockDocumentLines)
    .where(inArray(stockDocumentLines.documentId, [...ids]))
    .orderBy(asc(stockDocumentLines.createdAt), asc(stockDocumentLines.id));
  for (const r of rows) out.get(r.documentId)!.push(r);
  return out;
}

/** Cập nhật có điều kiện theo `version`; lệch thì `undefined` (bên gọi trả 409). */
export async function updateDoc(id: string, version: number, values: Partial<typeof stockDocuments.$inferInsert>): Promise<DocRow | undefined> {
  const [row] = await getDb()
    .update(stockDocuments)
    .set({ ...values, version: sql`${stockDocuments.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(stockDocuments.id, id), eq(stockDocuments.version, version)))
    .returning();
  return row;
}

export interface DocFilter {
  kinds: readonly DocRow['kind'][];
  status?: DocRow['status'] | undefined;
  /** Số phiếu hoặc ghi chú. */
  search?: string | undefined;
}

export async function listDocs(f: DocFilter, page: { limit: number; offset: number }): Promise<{ rows: DocRow[]; total: number }> {
  const term = f.search?.trim();
  const where = and(
    inArray(stockDocuments.kind, [...f.kinds]),
    f.status ? eq(stockDocuments.status, f.status) : undefined,
    term ? or(ilike(stockDocuments.number, `%${term}%`), ilike(stockDocuments.note, `%${term}%`)) : undefined,
  );
  const [rows, [total]] = await Promise.all([
    getDb()
      .select()
      .from(stockDocuments)
      .where(where)
      .orderBy(desc(stockDocuments.createdAt), desc(stockDocuments.id))
      .limit(page.limit)
      .offset(page.offset),
    getDb().select({ n: count() }).from(stockDocuments).where(where),
  ]);
  return { rows, total: total?.n ?? 0 };
}

/** Phiếu kho sinh từ các phiếu (xuất huỷ phần hỏng của kiểm hàng về). */
export function docsFromDocs(sourceIds: readonly string[]) {
  if (!sourceIds.length) return Promise.resolve([] as Pick<DocRow, 'id' | 'number' | 'sourceId'>[]);
  return getDb()
    .select({ id: stockDocuments.id, number: stockDocuments.number, sourceId: stockDocuments.sourceId })
    .from(stockDocuments)
    .where(and(eq(stockDocuments.sourceType, 'stock_document'), inArray(stockDocuments.sourceId, [...sourceIds])));
}

/** Số, loại của các phiếu (nhãn chứng từ trên thẻ kho, nguồn của phiếu sinh tiếp). */
export function docRefsOf(ids: readonly string[]) {
  if (!ids.length) return Promise.resolve([] as Pick<DocRow, 'id' | 'number' | 'kind'>[]);
  return getDb()
    .select({ id: stockDocuments.id, number: stockDocuments.number, kind: stockDocuments.kind })
    .from(stockDocuments)
    .where(inArray(stockDocuments.id, [...ids]));
}

/**
 * Tạm khoá theo biến thể (Documents/25 §7.1): phần giảm tồn thực của phiếu đang chờ duyệt. Xuất huỷ từ tồn thực, chuyển
 * chờ xử lý lấy số lượng; kiểm kê tồn thực lấy phần đếm thiếu. Phiếu lấy từ chờ xử lý không khoá tồn thực.
 */
export async function pendingLocks(variantIds?: readonly string[]): Promise<Map<string, number>> {
  const l = stockDocumentLines;
  const d = stockDocuments;
  if (variantIds && !variantIds.length) return new Map();
  const qty = sql<number>`sum(case when ${d.kind} = 'stocktake' then greatest(0, ${l.bookQty} - ${l.countedQty}) else ${l.quantity} end)::int`;
  const rows = await getDb()
    .select({ variantId: l.variantId, qty })
    .from(l)
    .innerJoin(d, eq(d.id, l.documentId))
    .where(
      and(
        eq(d.status, 'pending'),
        eq(d.area, 'on_hand'),
        inArray(d.kind, ['stocktake', 'write_off', 'to_quarantine']),
        variantIds ? inArray(l.variantId, [...variantIds]) : undefined,
      ),
    )
    .groupBy(l.variantId);
  return new Map(rows.filter((r) => r.qty > 0).map((r) => [r.variantId, r.qty]));
}

/** Phiếu kiểm kê đầu kỳ đang mở (nháp, chờ duyệt) của gian hàng, nguồn `shop_setup` (#245). */
export async function openingDocOf(shopId: string): Promise<DocRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(stockDocuments)
    .where(
      and(
        eq(stockDocuments.sourceType, 'shop_setup'),
        eq(stockDocuments.sourceId, shopId),
        inArray(stockDocuments.status, ['draft', 'pending']),
      ),
    );
  return row;
}

/**
 * Chèn phiếu kiểm kê đầu kỳ; gian hàng đã có phiếu đang mở thì không chèn (`stock_documents_opening_uq`) và trả
 * `undefined`. Lần gọi đua chờ giao dịch kia xong rồi mới quyết, nên đọc lại là thấy phiếu cũ.
 */
export async function insertOpeningDoc(values: typeof stockDocuments.$inferInsert): Promise<DocRow | undefined> {
  const [row] = await getDb()
    .insert(stockDocuments)
    .values(values)
    .onConflictDoNothing({
      target: [stockDocuments.companyId, stockDocuments.sourceId],
      where: sql`${stockDocuments.sourceType} = 'shop_setup' and ${stockDocuments.status} in ('draft', 'pending')`,
    })
    .returning();
  return row;
}

/** Trạng thái các phiếu theo id (channel đọc phiếu kiểm kê đầu kỳ của gian hàng, #198, #245); id lạ thì vắng. */
export async function docStatusesOf(ids: readonly string[]): Promise<Map<string, DocRow['status']>> {
  if (!ids.length) return new Map();
  const rows = await getDb()
    .select({ id: stockDocuments.id, status: stockDocuments.status })
    .from(stockDocuments)
    .where(inArray(stockDocuments.id, [...ids]));
  return new Map(rows.map((r) => [r.id, r.status]));
}

/** Phiếu kho sinh từ một chứng từ của module khác (xuất huỷ khi huỷ phiếu trả NCC, #210). */
export function docsFromSource(sourceType: string, sourceIds: readonly string[]) {
  if (!sourceIds.length) return Promise.resolve([] as Pick<DocRow, 'id' | 'number' | 'sourceId'>[]);
  return getDb()
    .select({ id: stockDocuments.id, number: stockDocuments.number, sourceId: stockDocuments.sourceId })
    .from(stockDocuments)
    .where(and(eq(stockDocuments.sourceType, sourceType), inArray(stockDocuments.sourceId, [...sourceIds])));
}
