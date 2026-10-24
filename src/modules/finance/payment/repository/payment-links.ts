import { and, desc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { currentCompanyId, getDb } from '../../../../shared/db/client.ts';
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

/** Mã theo `payment_code` trong công ty đang mở giao dịch (RLS). */
export async function findLinkByCode(paymentCode: string): Promise<PaymentLinkRow | undefined> {
  const [row] = await getDb().select().from(paymentLinks).where(eq(paymentLinks.paymentCode, paymentCode));
  return row;
}

/**
 * Mã theo `payment_code` **của mọi công ty**: gọi ngoài `withCompany` (role chủ bảng, RLS không FORCE), chỉ để webhook
 * biết mã thuộc công ty nào trước khi kiểm chữ ký (D16). Sau bước này mọi đọc/ghi chạy trong `withCompany`.
 */
export async function findLinkByCodeAnyCompany(paymentCode: string): Promise<PaymentLinkRow | undefined> {
  if (currentCompanyId()) throw new Error('findLinkByCodeAnyCompany gọi ngoài withCompany (đọc mọi công ty)');
  return findLinkByCode(paymentCode);
}

/** Mã `active` đã quá hạn không quá 24 giờ, mọi công ty (role chủ bảng), cho tra cứu quá hạn (§12.4, A8). */
export async function findOverdueLinksAnyCompany(now: Date, limit: number): Promise<PaymentLinkRow[]> {
  if (currentCompanyId()) throw new Error('findOverdueLinksAnyCompany gọi ngoài withCompany (đọc mọi công ty)');
  return getDb()
    .select()
    .from(paymentLinks)
    .where(
      and(
        eq(paymentLinks.status, 'active'),
        lte(paymentLinks.expiresAt, now),
        gt(paymentLinks.expiresAt, new Date(now.getTime() - 24 * 3600_000)),
      ),
    )
    // Mã vừa tra lỗi được `touchLink` đẩy xuống cuối.
    .orderBy(paymentLinks.updatedAt, paymentLinks.expiresAt)
    .limit(limit);
}

/** Mã của giao dịch thành công: `active` hoặc `expired` → `paid` (§12.2, T15). */
export async function markLinkPaid(linkId: string): Promise<void> {
  await getDb()
    .update(paymentLinks)
    .set({ status: 'paid', version: sql`${paymentLinks.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(paymentLinks.id, linkId), inArray(paymentLinks.status, ['active', 'expired'])));
}

/** Ghi `updated_at` = bây giờ: mã tra cứu lỗi xuống cuối hàng chờ của lượt sau. */
export async function touchLink(linkId: string): Promise<void> {
  await getDb().update(paymentLinks).set({ updatedAt: sql`now()` }).where(eq(paymentLinks.id, linkId));
}

/** Tra cứu quá hạn thấy chưa trả: `active` → `expired` (chỉ khi còn `active`). */
export async function expireLink(linkId: string): Promise<void> {
  await getDb()
    .update(paymentLinks)
    .set({ status: 'expired', version: sql`${paymentLinks.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(paymentLinks.id, linkId), eq(paymentLinks.status, 'active')));
}
