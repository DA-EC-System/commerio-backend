import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { stockDocumentLines, stockDocuments } from './schema.ts';

// Chạy trong `withCompany` của bên gọi.

/**
 * Số phiếu kho nháp hoặc chờ duyệt có SKU, ở dòng thường hay dòng "giao nhầm mẫu" (`actual_variant_id`). SKU không có
 * phiếu nào thì không có trong Map.
 */
export async function openDocumentCounts(variantIds: readonly string[]): Promise<Map<string, number>> {
  if (!variantIds.length) return new Map();
  const ids = [...variantIds];
  const rows = await getDb()
    .select({
      documentId: stockDocumentLines.documentId,
      variantId: stockDocumentLines.variantId,
      actualVariantId: stockDocumentLines.actualVariantId,
    })
    .from(stockDocumentLines)
    .innerJoin(stockDocuments, eq(stockDocuments.id, stockDocumentLines.documentId))
    .where(
      and(
        inArray(stockDocuments.status, ['draft', 'pending']),
        or(inArray(stockDocumentLines.variantId, ids), inArray(stockDocumentLines.actualVariantId, ids)),
      ),
    );
  const wanted = new Set(ids);
  const docs = new Map<string, Set<string>>();
  for (const r of rows) {
    for (const id of [r.variantId, r.actualVariantId]) {
      if (id && wanted.has(id)) docs.set(id, (docs.get(id) ?? new Set()).add(r.documentId));
    }
  }
  return new Map([...docs].map(([id, set]) => [id, set.size]));
}

/**
 * SKU đã dùng (#204 spec mục 6, chặn xoá hẳn sản phẩm), một câu cho cả lô; chứng từ ở mọi trạng thái, kể cả đã huỷ.
 * SKU không có thì không có trong Set. Gọi trong `withCompany`.
 */
export async function usedVariants(variantIds: readonly string[]): Promise<Set<string>> {
  if (!variantIds.length) return new Set();
  const ids = [...variantIds];
  // Thẻ kho; dòng phiếu kho ở dòng thường hay dòng "giao nhầm mẫu".
  const { rows } = await getDb().execute<{ id: string }>(sql`
    select variant_id as id from product.stock_moves where variant_id in ${ids}
    union select variant_id from product.stock_document_lines where variant_id in ${ids}
    union select actual_variant_id from product.stock_document_lines where actual_variant_id in ${ids}`);
  return new Set(rows.map((r) => r.id));
}
