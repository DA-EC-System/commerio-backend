import { and, eq, inArray } from 'drizzle-orm';
import { getDb, requireCompanyId } from '../../../../shared/db/client.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import { goodsReceipts, supplierReturns } from './schema.ts';

/** Id chứng từ của purchasing mà thẻ kho trỏ tới, theo loại (`stock_moves.source_type`). */
export interface PurchaseDocumentIds {
  readonly goodsReceipts: readonly string[];
  readonly supplierReturns: readonly string[];
}

/** Số phiếu theo id, tách theo loại như đầu vào. */
export interface PurchaseDocumentNumbers {
  readonly goodsReceipts: Map<string, string>;
  readonly supplierReturns: Map<string, string>;
}

const wanted = (ids: readonly string[]) => [...new Set(ids.filter(isUuid))];

/**
 * Số phiếu nhận (`NH-`) và phiếu trả NCC (`TN-`) theo id, cho thẻ kho của inventory (#206 phần 2a). Mỗi loại tra đúng
 * bảng của nó, một câu theo khoá chính, chỉ khi có id loại đó. Id không phải uuid, của công ty khác, hoặc đặt sai loại
 * thì vắng trong Map của loại đó. inventory nhận qua `ctx` (`product/index.ts`), vì purchasing đã import inventory.
 */
export async function purchaseDocumentNumbers(ids: PurchaseDocumentIds): Promise<PurchaseDocumentNumbers> {
  const companyId = requireCompanyId('purchaseDocumentNumbers');
  const receiptIds = wanted(ids.goodsReceipts);
  const returnIds = wanted(ids.supplierReturns);
  const db = getDb();
  // Cùng một kết nối của giao dịch: chạy tuần tự.
  const receipts = receiptIds.length
    ? await db
        .select({ id: goodsReceipts.id, number: goodsReceipts.number })
        .from(goodsReceipts)
        .where(and(eq(goodsReceipts.companyId, companyId), inArray(goodsReceipts.id, receiptIds)))
    : [];
  const returns = returnIds.length
    ? await db
        .select({ id: supplierReturns.id, number: supplierReturns.number })
        .from(supplierReturns)
        .where(and(eq(supplierReturns.companyId, companyId), inArray(supplierReturns.id, returnIds)))
    : [];
  return {
    goodsReceipts: new Map(receipts.map((r) => [r.id, r.number])),
    supplierReturns: new Map(returns.map((r) => [r.id, r.number])),
  };
}
