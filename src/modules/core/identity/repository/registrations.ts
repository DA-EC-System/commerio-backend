// Truy vấn `core.registrations` (#459). Chạy bằng role chủ bảng, ngoài `withCompany` (bảng không RLS).
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { registrations } from './schema.ts';

export type RegistrationRow = typeof registrations.$inferSelect;
export type NewRegistration = typeof registrations.$inferInsert;

/** Khoá giao dịch theo email: hai lần gửi form cùng email xếp hàng, trần theo email đếm đúng. */
export async function lockRegistrationEmail(email: string): Promise<void> {
  await getDb().execute(sql`select pg_advisory_xact_lock(hashtextextended(${`registration:${email}`}, 0))`);
}

/** Số lần đăng ký còn hạn và số thư đã gửi trong một giờ qua của một email. */
export async function emailUsage(email: string, now: Date): Promise<{ live: number; mailsLastHour: number }> {
  const hourAgo = new Date(now.getTime() - 3600_000);
  const [row] = await getDb()
    .select({
      live: sql<number>`count(*) filter (where ${registrations.expiresAt} > ${now})::int`,
      mails: sql<number>`coalesce(sum(${registrations.otpSendCount}) filter (where ${registrations.createdAt} > ${hourAgo}), 0)::int`,
    })
    .from(registrations)
    .where(eq(registrations.email, email));
  return { live: row?.live ?? 0, mailsLastHour: row?.mails ?? 0 };
}

export async function insertRegistration(row: NewRegistration): Promise<void> {
  await getDb().insert(registrations).values(row);
}

export async function lockRegistration(id: string): Promise<RegistrationRow | undefined> {
  const [row] = await getDb().select().from(registrations).where(eq(registrations.id, id)).for('update');
  return row;
}

/** Xin mã mới: mã cũ mất hiệu lực, đặt lại bộ đếm sai, tăng số thư. */
export async function markResent(id: string, requestedAt: Date, expiresAt: Date): Promise<void> {
  await getDb()
    .update(registrations)
    .set({
      otpHash: null,
      otpRequestedAt: requestedAt,
      otpExpiresAt: expiresAt,
      otpAttempts: 0,
      otpSendCount: sql`${registrations.otpSendCount} + 1`,
    })
    .where(eq(registrations.id, id));
}

export async function storeRegistrationOtp(id: string, otpHash: string): Promise<void> {
  await getDb().update(registrations).set({ otpHash }).where(eq(registrations.id, id));
}

export async function markAccountNotice(id: string, at: Date): Promise<void> {
  await getDb().update(registrations).set({ accountNoticeAt: at }).where(eq(registrations.id, id));
}

/** Đã gửi thư "email đã có tài khoản" cho email này sau mốc `since` chưa. */
export async function hasAccountNoticeSince(email: string, since: Date): Promise<boolean> {
  const rows = await getDb()
    .select({ id: registrations.id })
    .from(registrations)
    .where(and(eq(registrations.email, email), gt(registrations.accountNoticeAt, since)))
    .limit(1);
  return rows.length > 0;
}

export async function incrementOtpAttempt(id: string): Promise<void> {
  await getDb()
    .update(registrations)
    .set({ otpAttempts: sql`${registrations.otpAttempts} + 1` })
    .where(eq(registrations.id, id));
}

/** Xoá và trả dòng; dòng đã bị bên khác xoá thì `undefined`. */
export async function deleteRegistration(id: string): Promise<RegistrationRow | undefined> {
  const [row] = await getDb().delete(registrations).where(eq(registrations.id, id)).returning();
  return row;
}

export async function purgeRegistrationsBefore(createdBefore: Date): Promise<number> {
  const rows = await getDb()
    .delete(registrations)
    .where(lt(registrations.createdAt, createdBefore))
    .returning({ id: registrations.id });
  return rows.length;
}
