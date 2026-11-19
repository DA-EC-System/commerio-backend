// Đơn, yêu cầu trả của gian hàng bị xoá (#398). Chạy trong giao dịch, `withCompany` của bên gọi (channel).
import { asc, eq, inArray, or } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { orderLines, orders, returnRequestLines, returnRequests } from './schema.ts';

/** Id đơn có `shop_id`; id yêu cầu trả có `shop_id` hoặc trỏ một trong các đơn đó. Id tăng dần. */
export async function findShopOrderRefs(shopId: string): Promise<{ orderIds: string[]; returnRequestIds: string[] }> {
  const db = getDb();
  const orderRows = await db.select({ id: orders.id }).from(orders).where(eq(orders.shopId, shopId)).orderBy(asc(orders.id));
  const orderIds = orderRows.map((r) => r.id);
  const requestRows = await db
    .select({ id: returnRequests.id })
    .from(returnRequests)
    .where(orderIds.length ? or(eq(returnRequests.shopId, shopId), inArray(returnRequests.orderId, orderIds)) : eq(returnRequests.shopId, shopId))
    .orderBy(asc(returnRequests.id));
  return { orderIds, returnRequestIds: requestRows.map((r) => r.id) };
}

/** Xoá con trước cha: dòng yêu cầu trả → yêu cầu trả → dòng đơn → đơn. Trả số dòng đã xoá mỗi bảng. */
export async function deleteShopOrderRows(refs: { orderIds: readonly string[]; returnRequestIds: readonly string[] }) {
  const db = getDb();
  const requestIds = [...refs.returnRequestIds];
  const orderIds = [...refs.orderIds];
  const returnRequestLines_ = requestIds.length
    ? await db.delete(returnRequestLines).where(inArray(returnRequestLines.requestId, requestIds)).returning({ id: returnRequestLines.id })
    : [];
  const returnRequests_ = requestIds.length
    ? await db.delete(returnRequests).where(inArray(returnRequests.id, requestIds)).returning({ id: returnRequests.id })
    : [];
  const orderLines_ = orderIds.length
    ? await db.delete(orderLines).where(inArray(orderLines.orderId, orderIds)).returning({ id: orderLines.id })
    : [];
  const orders_ = orderIds.length ? await db.delete(orders).where(inArray(orders.id, orderIds)).returning({ id: orders.id }) : [];
  return {
    orders: orders_.length,
    orderLines: orderLines_.length,
    returnRequests: returnRequests_.length,
    returnRequestLines: returnRequestLines_.length,
  };
}
