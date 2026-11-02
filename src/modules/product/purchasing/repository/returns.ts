import { and, asc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { supplierReturnLines, supplierReturns } from './schema.ts';

// Phiếu trả NCC (B4). #109 chỉ lập nháp từ hàng lỗi giữ lại của phiếu nhận; máy trạng thái phiếu trả làm ở B4.

/** Phiếu trả NCC nháp do hệ thống lập khi ghi sổ phiếu nhận có lỗi (`created_by` trống, spec #109 Q8). */
export async function insertDraftReturn(v: { companyId: string; number: string; supplierId: string | null; sourceId: string }): Promise<string> {
  const [row] = await getDb()
    .insert(supplierReturns)
    .values({ ...v, source: 'receipt_defect' })
    .returning({ id: supplierReturns.id });
  return row!.id;
}

export async function insertReturnLines(
  companyId: string,
  returnId: string,
  lines: readonly { variantId: string; quantity: number; unitCost: string; sourceLineId: string }[],
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
