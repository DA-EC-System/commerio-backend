import { and, desc, eq, lte, sql } from 'drizzle-orm';
import { getDb } from '../../../shared/db/client.ts';
import { paymentLinks } from './schema.ts';

export type PaymentLinkRow = typeof paymentLinks.$inferSelect;

/** Đổi mã `active` của đơn sang `cancelled` (huỷ đơn, QT-36). */
export async function cancelActiveLinks(orderId: string): Promise<void> {
  await getDb()
    .update(paymentLinks)
    .set({ status: 'cancelled', version: sql`${paymentLinks.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(paymentLinks.orderId, orderId), eq(paymentLinks.status, 'active')));
}

/** Mã `active` của đơn (nhiều nhất một, unique một phần). */
export async function findActiveLink(orderId: string): Promise<PaymentLinkRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(paymentLinks)
    .where(and(eq(paymentLinks.orderId, orderId), eq(paymentLinks.status, 'active')));
  return row;
}

/** Mã `active` đã quá hạn (theo `now` của ứng dụng, cùng đồng hồ với lúc đọc) → `expired`, trước khi chèn mã mới (UC-PF-01 ngoại lệ b1). */
export async function expireStaleActiveLinks(orderId: string, now: Date): Promise<void> {
  await getDb()
    .update(paymentLinks)
    .set({ status: 'expired', version: sql`${paymentLinks.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(paymentLinks.orderId, orderId), eq(paymentLinks.status, 'active'), lte(paymentLinks.expiresAt, now)));
}

export async function insertPaymentLink(values: typeof paymentLinks.$inferInsert): Promise<PaymentLinkRow> {
  const [row] = await getDb().insert(paymentLinks).values(values).returning();
  return row!;
}

/** Mã của đơn, mới nhất trước. */
export async function findLinksOfOrder(orderId: string, limit: number): Promise<PaymentLinkRow[]> {
  return getDb()
    .select()
    .from(paymentLinks)
    .where(eq(paymentLinks.orderId, orderId))
    .orderBy(desc(paymentLinks.createdAt), desc(paymentLinks.id))
    .limit(limit);
}
