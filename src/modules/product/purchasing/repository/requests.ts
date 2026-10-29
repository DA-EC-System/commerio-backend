import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { goodsReceipts, purchaseRequestLines, purchaseRequests, suppliers } from './schema.ts';

// Mọi hàm chạy trong `withCompany` của service: RLS chỉ cho thấy đề nghị của công ty đang chọn.

const requestCols = {
  id: purchaseRequests.id,
  number: purchaseRequests.number,
  status: purchaseRequests.status,
  supplierId: purchaseRequests.supplierId,
  sourceReturnId: purchaseRequests.sourceReturnId,
  note: purchaseRequests.note,
  createdBy: purchaseRequests.createdBy,
  createdAt: purchaseRequests.createdAt,
  version: purchaseRequests.version,
};

export type RequestRow = NonNullable<Awaited<ReturnType<typeof findRequest>>>;
export type RequestStatus = RequestRow['status'];

export async function findRequest(id: string) {
  const [row] = await getDb().select(requestCols).from(purchaseRequests).where(eq(purchaseRequests.id, id));
  return row;
}

/** Khoá đề nghị tới hết giao dịch: mọi thao tác ghi lên đề nghị và phiếu nhận của nó khoá dòng này trước (spec #108 Q10). */
export async function lockRequest(id: string): Promise<RequestRow | undefined> {
  const [row] = await getDb().select(requestCols).from(purchaseRequests).where(eq(purchaseRequests.id, id)).for('update');
  return row;
}

export interface RequestFilter {
  page: number;
  pageSize: number;
  search?: string | undefined;
  status?: RequestStatus | undefined;
  supplierId?: string | undefined;
}

/** Một trang đề nghị, mới nhất trước. `search` khớp số đề nghị, ghi chú, tên NCC (không ký tự đại diện). */
export async function listRequests(filter: RequestFilter) {
  const where = and(
    filter.status ? eq(purchaseRequests.status, filter.status) : undefined,
    filter.supplierId ? eq(purchaseRequests.supplierId, filter.supplierId) : undefined,
    filter.search
      ? sql`(strpos(lower(${purchaseRequests.number}), lower(${filter.search})) > 0
          or strpos(lower(coalesce(${purchaseRequests.note}, '')), lower(${filter.search})) > 0
          or strpos(lower(coalesce(${suppliers.name}, '')), lower(${filter.search})) > 0)`
      : undefined,
  );
  // Tuần tự: hai câu cùng một client của giao dịch, pg không cho chạy chồng.
  const rows = await getDb()
    .select({ ...requestCols, supplierName: suppliers.name })
    .from(purchaseRequests)
    .leftJoin(suppliers, eq(suppliers.id, purchaseRequests.supplierId))
    .where(where)
    .orderBy(desc(purchaseRequests.createdAt), desc(purchaseRequests.id))
    .limit(filter.pageSize)
    .offset((filter.page - 1) * filter.pageSize);
  const [count] = await getDb()
    .select({ total: sql<number>`count(*)::int` })
    .from(purchaseRequests)
    .leftJoin(suppliers, eq(suppliers.id, purchaseRequests.supplierId))
    .where(where);
  return { rows, total: count!.total };
}

export async function insertRequest(values: {
  companyId: string;
  number: string;
  supplierId: string;
  source: 'manual' | 'reorder';
  note: string | null;
  createdBy: string;
}): Promise<string> {
  const [row] = await getDb().insert(purchaseRequests).values(values).returning({ id: purchaseRequests.id });
  return row!.id;
}

/** Đặt cột của đề nghị, tăng `version`. Bên gọi đã khoá dòng và so `version`. */
export async function updateRequest(id: string, set: Partial<typeof purchaseRequests.$inferInsert>): Promise<void> {
  await getDb()
    .update(purchaseRequests)
    .set({ ...set, version: sql`${purchaseRequests.version} + 1`, updatedAt: sql`now()` })
    .where(eq(purchaseRequests.id, id));
}

// ---------- Dòng ----------

const lineCols = {
  id: purchaseRequestLines.id,
  requestId: purchaseRequestLines.requestId,
  variantId: purchaseRequestLines.variantId,
  newProductName: purchaseRequestLines.newProductName,
  newCategoryId: purchaseRequestLines.newCategoryId,
  orderedQty: purchaseRequestLines.orderedQty,
  receivedQty: purchaseRequestLines.receivedQty,
  defectiveQty: purchaseRequestLines.defectiveQty,
  closedShortQty: purchaseRequestLines.closedShortQty,
  unitPrice: purchaseRequestLines.unitPrice,
  excluded: purchaseRequestLines.excluded,
};

export type LineRow = Awaited<ReturnType<typeof findLines>>[number];

/** Dòng của các đề nghị, theo thứ tự nhập. */
export function findLines(requestIds: readonly string[]) {
  return getDb()
    .select(lineCols)
    .from(purchaseRequestLines)
    .where(inArray(purchaseRequestLines.requestId, [...requestIds]))
    .orderBy(asc(purchaseRequestLines.createdAt), asc(purchaseRequestLines.id));
}

/** Khoá các dòng của đề nghị tới hết giao dịch (sau `lockRequest`), để cộng số nhận khi ghi sổ phiếu nhận. */
export function lockLines(requestId: string) {
  return getDb()
    .select(lineCols)
    .from(purchaseRequestLines)
    .where(eq(purchaseRequestLines.requestId, requestId))
    .orderBy(asc(purchaseRequestLines.createdAt), asc(purchaseRequestLines.id))
    .for('update');
}

export interface NewLine {
  variantId: string | null;
  newProductName: string | null;
  newCategoryId: string | null;
  orderedQty: number;
  /** Chuỗi thập phân của `numeric(18,2)`. */
  unitPrice: string;
}

/** Thứ tự dòng giữ bằng `created_at = now() + i µs`: bảng không có cột thứ tự (như catalog `orderedNow`). */
export async function insertLines(companyId: string, requestId: string, lines: readonly NewLine[], from = 0): Promise<void> {
  if (!lines.length) return;
  await getDb()
    .insert(purchaseRequestLines)
    .values(
      lines.map((l, i) => ({ ...l, companyId, requestId, createdAt: sql`now() + ${from + i} * interval '1 microsecond'` })),
    );
}

/** Xoá mọi dòng của đề nghị nháp để ghi lại (chưa phiếu nhận nào trỏ tới dòng nháp). */
export async function deleteLines(requestId: string): Promise<void> {
  await getDb().delete(purchaseRequestLines).where(eq(purchaseRequestLines.requestId, requestId));
}

export async function updateLine(id: string, set: Partial<typeof purchaseRequestLines.$inferInsert>): Promise<void> {
  await getDb()
    .update(purchaseRequestLines)
    .set({ ...set, version: sql`${purchaseRequestLines.version} + 1`, updatedAt: sql`now()` })
    .where(eq(purchaseRequestLines.id, id));
}

// ---------- Phiếu nhận của đề nghị (bảng của #109) ----------

export function receiptsOf(requestIds: readonly string[]) {
  return getDb()
    .select({ id: goodsReceipts.id, number: goodsReceipts.number, status: goodsReceipts.status, requestId: goodsReceipts.requestId })
    .from(goodsReceipts)
    .where(inArray(goodsReceipts.requestId, [...requestIds]))
    .orderBy(asc(goodsReceipts.createdAt), asc(goodsReceipts.id));
}

/**
 * Đang về theo biến thể: tổng còn chờ của dòng không bị loại thuộc đề nghị `ordered`, `partially_received`
 * (Documents/25 §3.1). Bỏ trống `variantIds` là mọi biến thể.
 */
export async function incomingByVariant(variantIds?: readonly string[]): Promise<Map<string, number>> {
  if (variantIds && !variantIds.length) return new Map();
  const l = purchaseRequestLines;
  const rows = await getDb()
    .select({
      variantId: l.variantId,
      qty: sql<number>`sum(${l.orderedQty} - ${l.receivedQty} - ${l.defectiveQty} - ${l.closedShortQty})::int`,
    })
    .from(l)
    .innerJoin(purchaseRequests, eq(purchaseRequests.id, l.requestId))
    .where(
      and(
        inArray(purchaseRequests.status, ['ordered', 'partially_received']),
        eq(l.excluded, false),
        variantIds ? inArray(l.variantId, [...variantIds]) : sql`${l.variantId} is not null`,
      ),
    )
    .groupBy(l.variantId);
  return new Map(rows.map((r) => [r.variantId!, r.qty]));
}
