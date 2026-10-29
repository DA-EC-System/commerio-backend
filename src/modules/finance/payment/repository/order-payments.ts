import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
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

export interface OrderPaymentFilter {
  status?: OrderPaymentRow['status'];
  refundStatus?: OrderPaymentRow['refundStatus'];
  /** `true`: chỉ đơn đã giao (tab COD chờ thu). */
  delivered?: boolean;
  deliveredFrom?: Date;
  deliveredTo?: Date;
}

/** Dòng trạng thái tiền của công ty (RLS) theo bộ lọc, ngày giao mới nhất trước rồi tới cập nhật mới nhất. */
export async function findOrderPaymentsWhere(f: OrderPaymentFilter): Promise<OrderPaymentRow[]> {
  return getDb()
    .select()
    .from(orderPayments)
    .where(
      and(
        f.status ? eq(orderPayments.status, f.status) : undefined,
        f.refundStatus ? eq(orderPayments.refundStatus, f.refundStatus) : undefined,
        f.delivered ? isNotNull(orderPayments.deliveredAt) : undefined,
        f.deliveredFrom ? gte(orderPayments.deliveredAt, f.deliveredFrom) : undefined,
        f.deliveredTo ? lt(orderPayments.deliveredAt, f.deliveredTo) : undefined,
      ),
    )
    .orderBy(sql`${orderPayments.deliveredAt} desc nulls last`, desc(orderPayments.updatedAt));
}
