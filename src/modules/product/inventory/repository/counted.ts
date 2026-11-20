// SKU kho đã có số (#460). Chạy trong `withCompany` của bên gọi.
import { sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';

/**
 * SKU trong `variantIds` kho đã có số thật: có thẻ kho ngăn tồn thực **tăng** (phiếu nhận, kiểm kê tăng, nhập lại hàng
 * hoàn, trả về kệ), trừ phiếu đảo bàn giao (chỉ bù lại số âm của bàn giao bắt buộc); hoặc nằm trên phiếu kiểm kê đã ghi
 * sổ (kiểm kê đếm 0 cho SKU đang 0 không ghi thẻ kho vì `applyMoves` bỏ dòng 0). Thẻ giảm (phiếu xuất theo kiện, kể cả
 * bàn giao bắt buộc làm tồn âm; xuất huỷ) và ngăn chờ xử lý không tính: SKU chưa từng nhập mà có đơn bàn giao bắt buộc
 * vẫn là chưa biết tồn (review Fable #460).
 */
export async function countedVariants(variantIds: readonly string[]): Promise<Set<string>> {
  if (!variantIds.length) return new Set();
  const ids = sql`array[${sql.join([...new Set(variantIds)].map((id) => sql`${id}::uuid`), sql`, `)}]`;
  const { rows } = await getDb().execute<{ id: string }>(sql`
    select v.id from unnest(${ids}) as v(id)
    where exists (
        select 1 from product.stock_moves m
        where m.variant_id = v.id and m.bucket = 'on_hand' and m.qty_change > 0
          and not exists (
            select 1 from product.stock_documents d
            where m.source_type = 'stock_document' and d.id = m.source_id and d.kind = 'shipment_reversal'))
      or exists (
        select 1 from product.stock_document_lines l join product.stock_documents d on d.id = l.document_id
        where l.variant_id = v.id and d.kind = 'stocktake' and d.status = 'posted')`);
  return new Set(rows.map((r) => r.id));
}
