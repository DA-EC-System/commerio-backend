// Đếm dòng tiền theo đơn cho xoá gian hàng (#398): finance chặn xoá khi có. Chạy trong `withCompany` của bên gọi.
import { count, inArray } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { orderPayments, paymentLinks, paymentTransactions } from './schema.ts';

/** Tổng số dòng `order_payments`, `payment_links`, `payment_transactions` của các đơn. */
export async function paymentRowsOfOrders(orderIds: readonly string[]): Promise<number> {
  if (!orderIds.length) return 0;
  const ids = [...orderIds];
  const db = getDb();
  const [[a], [b], [c]] = await Promise.all([
    db.select({ n: count() }).from(orderPayments).where(inArray(orderPayments.orderId, ids)),
    db.select({ n: count() }).from(paymentLinks).where(inArray(paymentLinks.orderId, ids)),
    db.select({ n: count() }).from(paymentTransactions).where(inArray(paymentTransactions.orderId, ids)),
  ]);
  return a!.n + b!.n + c!.n;
}
