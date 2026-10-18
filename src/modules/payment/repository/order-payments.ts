import { eq } from 'drizzle-orm';
import { getDb } from '../../../shared/db/client.ts';
import { orderPayments, type paymentStatus } from './schema.ts';

export type OrderPaymentRow = typeof orderPayments.$inferSelect;

/** Tạo dòng trạng thái tiền nếu đơn chưa có; đã có thì giữ nguyên. */
export async function insertOrderPaymentIfMissing(
  companyId: string,
  orderId: string,
  status: (typeof paymentStatus.enumValues)[number],
): Promise<void> {
  await getDb().insert(orderPayments).values({ companyId, orderId, status }).onConflictDoNothing();
}

/** Đọc trạng thái tiền; `lock` khoá dòng tới hết giao dịch (`FOR UPDATE`). */
export async function findOrderPayment(orderId: string, lock?: 'update'): Promise<OrderPaymentRow | undefined> {
  const query = getDb().select().from(orderPayments).where(eq(orderPayments.orderId, orderId));
  const [row] = await (lock ? query.for('update') : query);
  return row;
}
