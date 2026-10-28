import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { goodsReceiptLines, goodsReceipts, purchaseRequests, suppliers } from './schema.ts';

// Phiếu nhận (spec #109). Mọi hàm chạy trong `withCompany` của service: RLS chỉ cho thấy phiếu của công ty đang chọn.

const receiptCols = {
  id: goodsReceipts.id,
  number: goodsReceipts.number,
  requestId: goodsReceipts.requestId,
  status: goodsReceipts.status,
  deliveryMode: goodsReceipts.deliveryMode,
  checkDeadline: goodsReceipts.checkDeadline,
  shortResolution: goodsReceipts.shortResolution,
  followUpReceiptId: goodsReceipts.followUpReceiptId,
  resolutionNote: goodsReceipts.resolutionNote,
  resolvedBy: goodsReceipts.resolvedBy,
  resolvedAt: goodsReceipts.resolvedAt,
  note: goodsReceipts.note,
  statusReason: goodsReceipts.statusReason,
  createdBy: goodsReceipts.createdBy,
  createdAt: goodsReceipts.createdAt,
  postedBy: goodsReceipts.postedBy,
  postedAt: goodsReceipts.postedAt,
  selfApproved: goodsReceipts.selfApproved,
  version: goodsReceipts.version,
};

export type ReceiptRow = NonNullable<Awaited<ReturnType<typeof findReceipt>>>;
export type ReceiptStatus = ReceiptRow['status'];
type DbDeliveryMode = ReceiptRow['deliveryMode'];

export async function findReceipt(id: string) {
  const [row] = await getDb().select(receiptCols).from(goodsReceipts).where(eq(goodsReceipts.id, id));
  return row;
}

/** Khoá phiếu tới hết giao dịch; bên gọi đã khoá đề nghị của phiếu trước (thứ tự khoá, spec #108 Q10). */
export async function lockReceipt(id: string): Promise<ReceiptRow | undefined> {
  const [row] = await getDb().select(receiptCols).from(goodsReceipts).where(eq(goodsReceipts.id, id)).for('update');
  return row;
}

export interface ReceiptFilter {
  page: number;
  pageSize: number;
  search?: string | undefined;
  status?: ReceiptStatus | undefined;
  requestId?: string | undefined;
}

/** Một trang phiếu, mới nhất trước. `search` khớp số phiếu, số đề nghị (không ký tự đại diện). */
export async function listReceipts(filter: ReceiptFilter) {
  const where = and(
    filter.status ? eq(goodsReceipts.status, filter.status) : undefined,
    filter.requestId ? eq(goodsReceipts.requestId, filter.requestId) : undefined,
    filter.search
      ? sql`(strpos(lower(${goodsReceipts.number}), lower(${filter.search})) > 0
          or strpos(lower(${purchaseRequests.number}), lower(${filter.search})) > 0)`
      : undefined,
  );
  const rows = await getDb()
    .select({ ...receiptCols, requestNumber: purchaseRequests.number, supplierId: purchaseRequests.supplierId, supplierName: suppliers.name })
    .from(goodsReceipts)
    .innerJoin(purchaseRequests, eq(purchaseRequests.id, goodsReceipts.requestId))
    .leftJoin(suppliers, eq(suppliers.id, purchaseRequests.supplierId))
    .where(where)
    .orderBy(desc(goodsReceipts.createdAt), desc(goodsReceipts.id))
    .limit(filter.pageSize)
    .offset((filter.page - 1) * filter.pageSize);
  const [count] = await getDb()
    .select({ total: sql<number>`count(*)::int` })
    .from(goodsReceipts)
    .innerJoin(purchaseRequests, eq(purchaseRequests.id, goodsReceipts.requestId))
    .where(where);
  return { rows, total: count!.total };
}

export type ListedReceipt = Awaited<ReturnType<typeof listReceipts>>['rows'][number];

/** Người giao đã đi thì kho phải kiểm xong trong 24 giờ kể từ lúc lập phiếu (Documents/25 §4.1). */
const deadlineFrom = (mode: DbDeliveryMode, from: 'now' | 'created') =>
  mode === 'driver_left' ? sql`${from === 'now' ? sql`now()` : goodsReceipts.createdAt} + interval '24 hours'` : null;

export async function insertReceipt(values: {
  companyId: string;
  number: string;
  requestId: string;
  deliveryMode: DbDeliveryMode;
  note: string | null;
  createdBy: string;
}): Promise<string> {
  const [row] = await getDb()
    .insert(goodsReceipts)
    .values({ ...values, checkDeadline: deadlineFrom(values.deliveryMode, 'now') })
    .returning({ id: goodsReceipts.id });
  return row!.id;
}

/** Đổi cách giao, ghi chú; hạn kiểm tính lại theo lúc lập phiếu. */
export async function updateReceiptHeader(id: string, set: { deliveryMode: DbDeliveryMode; note: string | null }): Promise<void> {
  await getDb()
    .update(goodsReceipts)
    .set({
      ...set,
      checkDeadline: deadlineFrom(set.deliveryMode, 'created'),
      version: sql`${goodsReceipts.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(eq(goodsReceipts.id, id));
}

export async function updateReceipt(id: string, set: Partial<typeof goodsReceipts.$inferInsert>): Promise<void> {
  await getDb()
    .update(goodsReceipts)
    .set({ ...set, version: sql`${goodsReceipts.version} + 1`, updatedAt: sql`now()` })
    .where(eq(goodsReceipts.id, id));
}

// ---------- Dòng ----------

/** Thứ tự dòng giữ bằng `created_at = now() + i µs`, theo thứ tự dòng đề nghị (như `insertLines` của đề nghị). */
export async function insertReceiptLines(
  companyId: string,
  receiptId: string,
  lines: readonly { requestLineId: string; variantId: string }[],
): Promise<void> {
  if (!lines.length) return;
  await getDb()
    .insert(goodsReceiptLines)
    .values(lines.map((l, i) => ({ ...l, companyId, receiptId, createdAt: sql`now() + ${i} * interval '1 microsecond'` })));
}

export type ReceiptLineRow = Awaited<ReturnType<typeof receiptLines>>[number];

export function receiptLines(receiptIds: readonly string[]) {
  return getDb()
    .select({
      id: goodsReceiptLines.id,
      receiptId: goodsReceiptLines.receiptId,
      requestLineId: goodsReceiptLines.requestLineId,
      variantId: goodsReceiptLines.variantId,
      declaredQty: goodsReceiptLines.declaredQty,
      acceptedQty: goodsReceiptLines.acceptedQty,
      defectiveQty: goodsReceiptLines.defectiveQty,
      returnedOnSpotQty: goodsReceiptLines.returnedOnSpotQty,
      shortageQty: sql<number>`${goodsReceiptLines.shortageQty}`,
      reason: goodsReceiptLines.reason,
    })
    .from(goodsReceiptLines)
    .where(inArray(goodsReceiptLines.receiptId, [...receiptIds]))
    .orderBy(asc(goodsReceiptLines.createdAt), asc(goodsReceiptLines.id));
}

export async function updateReceiptLine(id: string, set: Partial<typeof goodsReceiptLines.$inferInsert>): Promise<void> {
  await getDb()
    .update(goodsReceiptLines)
    .set({ ...set, version: sql`${goodsReceiptLines.version} + 1`, updatedAt: sql`now()` })
    .where(eq(goodsReceiptLines.id, id));
}
