import { and, eq, inArray } from 'drizzle-orm';
import { getDb, requireCompanyId } from '../../../../shared/db/client.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import { goodsReceipts, supplierReturns } from './schema.ts';

/**
 * Số phiếu nhận (`NH-`) và phiếu trả NCC (`TN-`) theo id, cho thẻ kho của inventory (#206 phần 2a). Mỗi bảng một câu
 * theo khoá chính; id không phải uuid hoặc của công ty khác thì vắng trong Map. inventory nhận qua `ctx`
 * (`product/index.ts`), vì purchasing đã import inventory.
 */
export async function purchaseDocumentNumbers(ids: readonly string[]): Promise<Map<string, string>> {
  const companyId = requireCompanyId('purchaseDocumentNumbers');
  const wanted = [...new Set(ids.filter(isUuid))];
  if (!wanted.length) return new Map();
  const db = getDb();
  const receipts = await db
    .select({ id: goodsReceipts.id, number: goodsReceipts.number })
    .from(goodsReceipts)
    .where(and(eq(goodsReceipts.companyId, companyId), inArray(goodsReceipts.id, wanted)));
  // Cùng một kết nối của giao dịch: chạy tuần tự.
  const returns = await db
    .select({ id: supplierReturns.id, number: supplierReturns.number })
    .from(supplierReturns)
    .where(and(eq(supplierReturns.companyId, companyId), inArray(supplierReturns.id, wanted)));
  return new Map([...receipts, ...returns].map((r) => [r.id, r.number]));
}
