import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { OPEN_RETURN_STATUSES } from '../domain/return.ts';
import { orderLines, orders, returnRequestLines, returnRequests } from './schema.ts';

// Chạy trong `withCompany` của bên gọi. Mỗi hàm một câu cho cả lô SKU; SKU không có chứng từ nào thì không có trong Map.

const toMap = (rows: { variantId: string | null; n: number }[]) =>
  new Map(rows.flatMap((r) => (r.variantId ? [[r.variantId, r.n] as const] : [])));

/** Số đơn chưa xong (`unpaid`, `processing`; spec 204 D9) có dòng mang SKU chưa huỷ hết. */
export async function openOrderCounts(variantIds: readonly string[]): Promise<Map<string, number>> {
  if (!variantIds.length) return new Map();
  const rows = await getDb()
    .select({ variantId: orderLines.variantId, n: sql<number>`count(distinct ${orderLines.orderId})::int` })
    .from(orderLines)
    .innerJoin(orders, eq(orders.id, orderLines.orderId))
    .where(
      and(
        inArray(orders.status, ['unpaid', 'processing']),
        inArray(orderLines.variantId, [...variantIds]),
        lt(orderLines.cancelledQty, orderLines.quantity),
      ),
    )
    .groupBy(orderLines.variantId);
  return toMap(rows);
}

/** Số yêu cầu trả đang mở có dòng mang SKU. */
export async function openReturnCountsByVariant(variantIds: readonly string[]): Promise<Map<string, number>> {
  if (!variantIds.length) return new Map();
  const rows = await getDb()
    .select({ variantId: returnRequestLines.variantId, n: sql<number>`count(distinct ${returnRequestLines.requestId})::int` })
    .from(returnRequestLines)
    .innerJoin(returnRequests, eq(returnRequests.id, returnRequestLines.requestId))
    .where(and(inArray(returnRequests.status, [...OPEN_RETURN_STATUSES]), inArray(returnRequestLines.variantId, [...variantIds])))
    .groupBy(returnRequestLines.variantId);
  return toMap(rows);
}

/**
 * SKU đã dùng (#204 spec mục 6, chặn xoá hẳn sản phẩm), một câu cho cả lô; chứng từ ở mọi trạng thái, kể cả đã huỷ.
 * SKU không có thì không có trong Set. Gọi trong `withCompany`.
 */
export async function usedVariants(variantIds: readonly string[]): Promise<Set<string>> {
  if (!variantIds.length) return new Set();
  const ids = [...variantIds];
  // Dòng kiện, kiện trả không khớp là bảng của fulfillment cùng schema `order`: đọc bằng SQL, không import repository của
  // module con khác.
  const { rows } = await getDb().execute<{ id: string }>(sql`
    select variant_id as id from "order".order_lines where variant_id in ${ids}
    union select variant_id from "order".return_request_lines where variant_id in ${ids}
    union select variant_id from "order".package_lines where variant_id in ${ids}
    union select variant_id from "order".unmatched_return_parcel_lines where variant_id in ${ids}`);
  return new Set(rows.map((r) => r.id));
}
