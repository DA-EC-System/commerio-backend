// Thư báo CEO, Admin khi gian hàng sắp hết hoặc đã mất uỷ quyền sàn (#312). Xếp thư: ghi một dòng `shop_reauth_mails`
// (unique theo mốc) và phát `channel.shop_reauth_mail` trong cùng giao dịch. Gửi thư: consumer trong worker, qua
// `shared/mail`. Việc nền mỗi 15 phút xếp mốc tới hạn; lúc chuyển sang `needs_reauth` thì `markNeedsReauth` xếp ngay.
import { activeMemberEmailsWithRoles, BUILTIN_ROLES, type EventEnvelope, type EventPayload, lastTransitionsAt, publishEvent } from '../../../core/index.ts';
import { env } from '../../../../shared/config/env.ts';
import { requireCompanyId, withCompany } from '../../../../shared/db/client.ts';
import { logger } from '../../../../shared/logger.ts';
import { MailError, sendMail } from '../../../../shared/mail/index.ts';
import { dueReauthMail, type ReauthMailMilestone } from '../domain/reauth-mail.ts';
import { authDeadline } from '../domain/shop.ts';
import { findReauthMail, findReauthMailCandidatesAnyCompany, insertReauthMail } from '../repository/reauth-mails.ts';
import { findShopRow, type ShopRow } from '../repository/shops.ts';
import { renderReauthMail } from './reauth-mail-text.ts';

export const REAUTH_MAIL_CONSUMER = 'channel-shop-reauth-mail';
/** Việc nền xếp thư chạy mỗi 15 phút (issue #312). */
export const REAUTH_MAIL_INTERVAL_MS = 15 * 60_000;
const TEMPLATE = 'shop_reauth';
const ENTITY = 'shops';

type ReauthMailEvent = EventEnvelope<'channel.shop_reauth_mail', EventPayload<'channel.shop_reauth_mail'>>;

/**
 * Lúc chuyển sang `needs_reauth` gần nhất. Chỉ `lose_auth` dẫn tới `needs_reauth` (máy trạng thái ở `domain/shop.ts`),
 * nên lần chuyển cuối của gian hàng đang `needs_reauth` chính là lần đó.
 */
async function lostAtOf(row: ShopRow): Promise<Date | null> {
  if (row.status !== 'needs_reauth') return null;
  return (await lastTransitionsAt(ENTITY, [row.id])).get(row.id) ?? null;
}

async function milestoneOf(row: ShopRow, now: Date): Promise<ReauthMailMilestone | null> {
  const deadline = authDeadline(row.authExpiresAt, row.refreshExpiresAt);
  return dueReauthMail({ status: row.status, deadline, lostAt: await lostAtOf(row) }, now);
}

/**
 * Xếp thư cho mốc đã tới của gian hàng, trong `withCompany` của bên gọi. Mốc đã xếp thì unique của CSDL bỏ qua, không
 * phát sự kiện. Trả true khi vừa xếp một thư.
 */
export async function queueDueReauthMail(shopId: string, now: Date): Promise<boolean> {
  requireCompanyId('queueDueReauthMail');
  const row = await findShopRow(shopId);
  if (!row) return false;
  const milestone = await milestoneOf(row, now);
  if (!milestone) return false;
  const mail = await insertReauthMail(shopId, milestone);
  if (!mail) return false;
  await publishEvent({ type: 'channel.shop_reauth_mail', aggregateId: shopId, payload: { mailId: mail.id, shopId } });
  return true;
}

/** Một lượt của việc nền: mọi gian hàng có thể tới mốc, mỗi gian hàng một giao dịch; lỗi một gian hàng không chặn gian hàng khác. */
export async function queueReauthMailsOnce(now = new Date()): Promise<number> {
  let queued = 0;
  for (const shop of await findReauthMailCandidatesAnyCompany()) {
    try {
      if (await withCompany(shop.companyId, () => queueDueReauthMail(shop.id, now))) queued++;
    } catch (err) {
      logger.error({ err, shopId: shop.id }, 'xếp thư báo mất uỷ quyền lỗi');
    }
  }
  return queued;
}

/** Chạy `queueReauthMailsOnce` ngay rồi mỗi 15 phút, không chồng lượt. Trả hàm dừng (chờ lượt đang chạy). */
export function startReauthMailLoop(intervalMs = REAUTH_MAIL_INTERVAL_MS): () => Promise<void> {
  let running: Promise<unknown> | undefined;
  const tick = () => {
    running ??= queueReauthMailsOnce()
      .catch((err: unknown) => logger.error({ err }, 'việc nền xếp thư báo mất uỷ quyền lỗi'))
      .finally(() => {
        running = undefined;
      });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return async () => {
    clearInterval(timer);
    await running;
  };
}

/**
 * Consumer `channel.shop_reauth_mail`: chạy trong `withCompany` của sự kiện (consumer `shared`). Thư đã cũ (gian hàng
 * đã nối lại, đã ngắt, hoặc hạn đã đổi lúc thư tới lượt) thì bỏ. Người nhận: CEO, Admin đang hoạt động của công ty,
 * không gồm quản trị nền tảng; một thư gửi chung mọi người nhận để lỗi tạm thử lại không thành gửi trùng cho người đã nhận.
 * SMTP lỗi tạm thì ném để outbox thử lại; lỗi vĩnh viễn thì ghi log, không thử lại.
 */
export async function handleReauthMail(event: ReauthMailEvent): Promise<void> {
  const { mailId, shopId } = event.payload;
  const log = { eventId: event.eventId, mailId, shopId };
  const mail = await findReauthMail(mailId);
  const row = mail ? await findShopRow(shopId) : undefined;
  if (!mail || !row) {
    logger.info(log, 'bỏ thư báo mất uỷ quyền: không còn dòng');
    return;
  }
  const deadline = authDeadline(row.authExpiresAt, row.refreshExpiresAt);
  const lostAt = await lostAtOf(row);
  const current =
    mail.stage === 'lost'
      ? row.status === 'needs_reauth' && lostAt?.getTime() === mail.deadline.getTime()
      : row.status === 'active' && deadline?.getTime() === mail.deadline.getTime();
  if (!current) {
    logger.info({ ...log, status: row.status }, 'bỏ thư báo mất uỷ quyền: gian hàng đã đổi');
    return;
  }
  const recipients = await activeMemberEmailsWithRoles([BUILTIN_ROLES.ceo.id, BUILTIN_ROLES.admin.id]);
  if (recipients.length === 0) {
    logger.warn(log, 'bỏ thư báo mất uỷ quyền: công ty không có CEO, Admin đang hoạt động');
    return;
  }
  const message = renderReauthMail({
    stage: mail.stage,
    shopId,
    shopName: row.shopName,
    platform: row.platform,
    authDeadline: deadline,
    lostAt,
    webUrl: env.PUBLIC_WEB_URL,
  });
  try {
    await sendMail({ to: recipients.join(', '), ...message }, TEMPLATE);
  } catch (err) {
    if (err instanceof MailError && err.kind === 'permanent') {
      logger.error({ ...log, smtpCode: err.smtpCode }, 'gửi thư báo mất uỷ quyền lỗi vĩnh viễn');
      return;
    }
    throw err;
  }
  logger.info({ ...log, stage: mail.stage, seq: mail.seq, recipients: recipients.length }, 'đã gửi thư báo mất uỷ quyền');
}
