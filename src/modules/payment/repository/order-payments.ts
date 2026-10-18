import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
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

/** Đổi trạng thái tiền của dòng đã khoá; tăng `version`, ghi `updated_at`. */
export async function updateOrderPayment(
  orderId: string,
  values: Partial<Pick<OrderPaymentRow, 'status' | 'refundStatus' | 'paidAt'>>,
): Promise<OrderPaymentRow> {
  const [row] = await getDb()
    .update(orderPayments)
    .set({ ...values, version: sql`${orderPayments.version} + 1`, updatedAt: sql`now()` })
    .where(eq(orderPayments.orderId, orderId))
    .returning();
  return row!;
}

/** Ngày giao, chỉ ghi lần đầu (R2). */
export async function setDeliveredAtIfMissing(orderId: string, at: Date): Promise<void> {
  await getDb()
    .update(orderPayments)
    .set({ deliveredAt: at })
    .where(and(eq(orderPayments.orderId, orderId), isNull(orderPayments.deliveredAt)));
}

export async function findOrderPayments(orderIds: readonly string[]): Promise<OrderPaymentRow[]> {
  return getDb()
    .select()
    .from(orderPayments)
    .where(inArray(orderPayments.orderId, [...orderIds]));
}
