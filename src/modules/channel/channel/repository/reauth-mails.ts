// Thư báo mất uỷ quyền đã xếp (#312). Chống gửi trùng nằm ở CSDL (unique và EXCLUDE theo ngưỡng lệch hạn), không ở bên gọi.
import { and, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { getDb, requireCompanyId } from '../../../../shared/db/client.ts';
import type { ReauthMailMilestone } from '../domain/reauth-mail.ts';
import { shopReauthMails, shops } from './schema.ts';

export type ReauthMailRow = typeof shopReauthMails.$inferSelect;
export type ReauthMailOutcome = NonNullable<ReauthMailRow['outcome']>;

/**
 * Ghi mốc thư; mốc đã có (job chạy lại, chạy trùng, hai worker, hạn chỉ lệch vài giây sau khi làm mới token) thì không
 * ghi, trả `undefined`. `ON CONFLICT DO NOTHING` không chỉ khoá nên bắt cả unique lẫn EXCLUDE. Trong `withCompany`.
 */
export async function insertReauthMail(shopId: string, milestone: ReauthMailMilestone, now: Date): Promise<ReauthMailRow | undefined> {
  const companyId = requireCompanyId('insertReauthMail');
  const [row] = await getDb()
    .insert(shopReauthMails)
    .values({ companyId, shopId, ...milestone, queuedAt: now })
    .onConflictDoNothing()
    .returning();
  return row;
}

/** `forUpdate`: consumer khoá dòng để hai sự kiện của cùng thư (gốc và bản xếp lại) không cùng gửi. */
export async function findReauthMail(id: string, opts: { forUpdate?: boolean } = {}): Promise<ReauthMailRow | undefined> {
  const query = getDb().select().from(shopReauthMails).where(eq(shopReauthMails.id, id));
  const [row] = opts.forUpdate ? await query.for('update') : await query;
  return row;
}

/** Ghi kết quả cuối của thư (chỉ khi chưa có kết quả). */
export async function finishReauthMail(id: string, outcome: ReauthMailOutcome): Promise<void> {
  await getDb()
    .update(shopReauthMails)
    .set({ outcome, finishedAt: sql`now()` })
    .where(and(eq(shopReauthMails.id, id), isNull(shopReauthMails.outcome)));
}

/** Tính thêm một lần phát sự kiện; trả false khi thư đã có kết quả hoặc lần phát đã đổi (việc nền khác vừa xếp lại). */
export async function bumpReauthMailAttempt(row: ReauthMailRow, now: Date): Promise<boolean> {
  const rows = await getDb()
    .update(shopReauthMails)
    .set({ attempts: row.attempts + 1, queuedAt: now })
    .where(and(eq(shopReauthMails.id, row.id), isNull(shopReauthMails.outcome), eq(shopReauthMails.attempts, row.attempts)))
    .returning({ id: shopReauthMails.id });
  return rows.length > 0;
}

/**
 * Gian hàng có thể tới mốc thư, mọi công ty (role chủ bảng, chạy ngoài `withCompany` như `findActiveShopsAnyCompany`):
 * `needs_reauth`, hoặc `active` có hạn uỷ quyền. Luật mốc xét lại trong `withCompany` của từng gian hàng.
 */
export async function findReauthMailCandidatesAnyCompany(): Promise<{ id: string; companyId: string }[]> {
  return getDb()
    .select({ id: shops.id, companyId: shops.companyId })
    .from(shops)
    .where(
      or(
        eq(shops.status, 'needs_reauth'),
        and(eq(shops.status, 'active'), or(isNotNull(shops.authExpiresAt), isNotNull(shops.refreshExpiresAt))),
      ),
    );
}

/** Thư chưa có kết quả, phát lần gần nhất trước `before`, mọi công ty (role chủ bảng, ngoài `withCompany`). */
export async function findPendingReauthMailsAnyCompany(before: Date): Promise<{ id: string; companyId: string }[]> {
  return getDb()
    .select({ id: shopReauthMails.id, companyId: shopReauthMails.companyId })
    .from(shopReauthMails)
    .where(and(isNull(shopReauthMails.outcome), lt(shopReauthMails.queuedAt, before)));
}
