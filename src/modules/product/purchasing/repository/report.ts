import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { inVnDays } from '../../../../shared/db/vn-time.ts';
import { goodsReceiptLines, goodsReceipts, purchaseRequests, suppliers } from './schema.ts';

/**
 * Số liệu phiếu nhận theo NCC trong kỳ `[from, to]` (ngày giờ Việt Nam, tính cả hai đầu). Chỉ tính phiếu đã ghi sổ.
 * Điều kiện kỳ đặt trong ON của join phiếu để NCC chưa có phiếu vẫn ra một dòng số 0.
 */
export function supplierReport(from: string, to: string) {
  const r = goodsReceipts;
  const l = goodsReceiptLines;
  return getDb()
    .select({
      supplierId: suppliers.id,
      supplierName: suppliers.name,
      receiptCount: sql<number>`count(distinct ${r.id})::int`,
      shortReceiptCount: sql<number>`(count(distinct ${r.id}) filter (where ${r.status} in ('short', 'resolved')))::int`,
      deliveredQty: sql<number>`coalesce(sum(${l.acceptedQty} + ${l.defectiveQty} + ${l.returnedOnSpotQty}), 0)::int`,
      defectQty: sql<number>`coalesce(sum(${l.defectiveQty} + ${l.returnedOnSpotQty}), 0)::int`,
    })
    .from(suppliers)
    .leftJoin(purchaseRequests, eq(purchaseRequests.supplierId, suppliers.id))
    .leftJoin(r, and(eq(r.requestId, purchaseRequests.id), sql`${r.postedAt} is not null`, inVnDays(sql`${r.postedAt}`, from, to)))
    .leftJoin(l, eq(l.receiptId, r.id))
    .groupBy(suppliers.id, suppliers.name)
    .orderBy(sql`lower(${suppliers.name})`, suppliers.id);
}
