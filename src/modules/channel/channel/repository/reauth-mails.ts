// Thư báo mất uỷ quyền đã xếp (#312). Chống gửi trùng nằm ở unique `shop_reauth_mails_milestone_uq`, không ở bên gọi.
import { and, eq, isNotNull, or } from 'drizzle-orm';
import { getDb, requireCompanyId } from '../../../../shared/db/client.ts';
import type { ReauthMailMilestone } from '../domain/reauth-mail.ts';
import { shopReauthMails, shops } from './schema.ts';

export type ReauthMailRow = typeof shopReauthMails.$inferSelect;

/** Ghi mốc thư; mốc đã có (job chạy lại, chạy trùng, hai worker) thì không ghi, trả `undefined`. Trong `withCompany`. */
export async function insertReauthMail(shopId: string, milestone: ReauthMailMilestone): Promise<ReauthMailRow | undefined> {
  const companyId = requireCompanyId('insertReauthMail');
  const [row] = await getDb()
    .insert(shopReauthMails)
    .values({ companyId, shopId, ...milestone })
    .onConflictDoNothing({ target: [shopReauthMails.shopId, shopReauthMails.deadline, shopReauthMails.stage, shopReauthMails.seq] })
    .returning();
  return row;
}

export async function findReauthMail(id: string): Promise<ReauthMailRow | undefined> {
  const [row] = await getDb().select().from(shopReauthMails).where(eq(shopReauthMails.id, id));
  return row;
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

