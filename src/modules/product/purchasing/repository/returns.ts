import { and, asc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { supplierReturnLines, supplierReturns } from './schema.ts';

// Phiếu trả NCC (B4). #109 chỉ lập nháp từ hàng lỗi giữ lại của phiếu nhận; máy trạng thái phiếu trả làm ở B4.

/** Phiếu trả NCC nháp do hệ thống lập khi ghi sổ phiếu nhận có lỗi (`created_by` trống, spec #109 Q8). */
export async function insertDraftReturn(v: {
  companyId: string;
  number: string;
  supplierId: string | null;
  sourceId: string;
  source?: (typeof supplierReturns.$inferInsert)['source'];
  note?: string | null;
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
