import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import {
  goodsReceiptLines,
  goodsReceipts,
  purchaseRequestLines,
  purchaseRequests,
  supplierReturnLines,
  supplierReturns,
} from './schema.ts';

// Chạy trong `withCompany` của bên gọi. Mỗi hàm một câu cho cả lô SKU; SKU không có chứng từ nào thì không có trong Map.

/** Đề nghị nhập chưa xong: chưa từ chối, huỷ, nhận đủ hay đóng thiếu. */
const OPEN_REQUEST_STATUSES = ['draft', 'pending_approval', 'changes_requested', 'approved', 'ordered', 'partially_received'] as const;
/** Phiếu trả NCC chưa có kết quả (NCC chưa hoàn tiền, bù hàng hay trả lại). */
const OPEN_RETURN_STATUSES = ['draft', 'pending_approval', 'sent'] as const;

const toMap = (rows: { variantId: string | null; n: number }[]) =>
  new Map(rows.flatMap((r) => (r.variantId ? [[r.variantId, r.n] as const] : [])));

/** Số đề nghị nhập chưa xong có dòng (không bị loại) mang SKU. */
export async function openRequestCounts(variantIds: readonly string[]): Promise<Map<string, number>> {
  if (!variantIds.length) return new Map();
  const rows = await getDb()
    .select({ variantId: purchaseRequestLines.variantId, n: sql<number>`count(distinct ${purchaseRequestLines.requestId})::int` })
    .from(purchaseRequestLines)
    .innerJoin(purchaseRequests, eq(purchaseRequests.id, purchaseRequestLines.requestId))
    .where(
      and(
        inArray(purchaseRequests.status, [...OPEN_REQUEST_STATUSES]),
        eq(purchaseRequestLines.excluded, false),
        inArray(purchaseRequestLines.variantId, [...variantIds]),
      ),
    )
    .groupBy(purchaseRequestLines.variantId);
  return toMap(rows);
}

/** Số phiếu nhận đang kiểm (`counting`, chưa ghi sổ) có SKU. */
export async function countingReceiptCounts(variantIds: readonly string[]): Promise<Map<string, number>> {
  if (!variantIds.length) return new Map();
  const rows = await getDb()
    .select({ variantId: goodsReceiptLines.variantId, n: sql<number>`count(distinct ${goodsReceiptLines.receiptId})::int` })
    .from(goodsReceiptLines)
    .innerJoin(goodsReceipts, eq(goodsReceipts.id, goodsReceiptLines.receiptId))
    .where(and(eq(goodsReceipts.status, 'counting'), inArray(goodsReceiptLines.variantId, [...variantIds])))
    .groupBy(goodsReceiptLines.variantId);
  return toMap(rows);
}

/** Số phiếu trả NCC chưa có kết quả có SKU. */
export async function openSupplierReturnCounts(variantIds: readonly string[]): Promise<Map<string, number>> {
  if (!variantIds.length) return new Map();
  const rows = await getDb()
    .select({ variantId: supplierReturnLines.variantId, n: sql<number>`count(distinct ${supplierReturnLines.returnId})::int` })
    .from(supplierReturnLines)
    .innerJoin(supplierReturns, eq(supplierReturns.id, supplierReturnLines.returnId))
    .where(and(inArray(supplierReturns.status, [...OPEN_RETURN_STATUSES]), inArray(supplierReturnLines.variantId, [...variantIds])))
    .groupBy(supplierReturnLines.variantId);
  return toMap(rows);
}

/**
 * SKU đã dùng (#204 spec mục 6, chặn xoá hẳn sản phẩm), một câu cho cả lô; chứng từ ở mọi trạng thái, kể cả đã huỷ.
 * SKU không có thì không có trong Set. Gọi trong `withCompany`.
 */
export async function usedVariants(variantIds: readonly string[]): Promise<Set<string>> {
  if (!variantIds.length) return new Set();
  const ids = [...variantIds];
  const { rows } = await getDb().execute<{ id: string }>(sql`
    select variant_id as id from product.purchase_request_lines where variant_id in ${ids}
    union select variant_id from product.goods_receipt_lines where variant_id in ${ids}
    union select variant_id from product.supplier_return_lines where variant_id in ${ids}
    union select v.id from product.product_variants v
      join product.purchase_request_lines l on l.new_parent_product_id = v.product_id and l.variant_id is null
      join product.purchase_requests r on r.id = l.request_id
      where v.id in ${ids} and not l.excluded
        and r.status in ('draft', 'pending_approval', 'changes_requested', 'approved', 'ordered', 'partially_received')`);
  return new Set(rows.map((r) => r.id));
}
