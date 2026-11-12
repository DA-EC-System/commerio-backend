// Thư báo CEO, Admin khi gian hàng sắp hết hoặc đã mất uỷ quyền sàn (#312). Xếp thư: ghi một dòng `shop_reauth_mails`
// (CSDL chặn mốc trùng) và phát `channel.shop_reauth_mail` trong cùng giao dịch. Gửi thư: consumer trong worker, qua
// `shared/mail`, ghi kết quả vào dòng. Việc nền mỗi 15 phút xếp mốc tới hạn và xếp lại thư chưa gửi được (outbox chỉ thử
// 1 s, 5 s, 30 s rồi bỏ vào DLQ); lúc chuyển sang `needs_reauth` thì `markNeedsReauth` xếp thư đầu ngay.
import { activeMemberEmailsWithRoles, BUILTIN_ROLES, type EventEnvelope, type EventPayload, lastTransitionsAt, publishEvent } from '../../../core/index.ts';
import { env } from '../../../../shared/config/env.ts';
import { requireCompanyId, withCompany } from '../../../../shared/db/client.ts';
import { logger } from '../../../../shared/logger.ts';
import { MailError, sendMail } from '../../../../shared/mail/index.ts';
import { dueReauthMail, isCurrentMail, type ReauthMailMilestone } from '../domain/reauth-mail.ts';
import { authDeadline } from '../domain/shop.ts';
import {
  bumpReauthMailAttempt,
  findPendingReauthMailsAnyCompany,
  findReauthMail,
  findReauthMailCandidatesAnyCompany,
  finishReauthMail,
  insertReauthMail,
  type ReauthMailRow,
} from '../repository/reauth-mails.ts';
import { findShopRow, type ShopRow } from '../repository/shops.ts';
import { renderReauthMail } from './reauth-mail-text.ts';

export const REAUTH_MAIL_CONSUMER = 'channel-shop-reauth-mail';
/** Việc nền xếp thư chạy mỗi 15 phút (issue #312). */
export const REAUTH_MAIL_INTERVAL_MS = 15 * 60_000;
/** Thư chưa có kết quả sau chừng này kể từ lần phát gần nhất thì coi như outbox đã bỏ cuộc (thử hết trong khoảng 36 giây). */
export const REAUTH_MAIL_RETRY_AFTER_MS = 10 * 60_000;
/** Số lần phát sự kiện tối đa của một thư, kể cả lần đầu (CHECK `shop_reauth_mails_attempts`): khoảng 2 giờ SMTP hỏng. */
export const REAUTH_MAIL_MAX_ATTEMPTS = 8;
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

const publish = (mail: ReauthMailRow) =>
  publishEvent({ type: 'channel.shop_reauth_mail', aggregateId: mail.shopId, payload: { mailId: mail.id, shopId: mail.shopId } });

/**
 * Xếp thư cho mốc đã tới của gian hàng, trong `withCompany` của bên gọi. Mốc đã xếp (kể cả hạn chỉ lệch vài giây sau
 * khi làm mới token) thì CSDL bỏ qua, không phát sự kiện. Trả true khi vừa xếp một thư.
 */
export async function queueDueReauthMail(shopId: string, now: Date): Promise<boolean> {
  requireCompanyId('queueDueReauthMail');
  const row = await findShopRow(shopId);
  if (!row) return false;
  const milestone = await milestoneOf(row, now);
  if (!milestone) return false;
  const mail = await insertReauthMail(shopId, milestone, now);
  if (!mail) return false;
  await publish(mail);
  return true;
}

/**
 * Thư chưa có kết quả mà lần phát gần nhất đã quá `REAUTH_MAIL_RETRY_AFTER_MS`, trong `withCompany`: thư đã cũ (gian hàng
 * đổi, mốc sau đã thay) thì ghi `stale`; đã phát đủ `REAUTH_MAIL_MAX_ATTEMPTS` lần thì `failed`; còn lại phát lại sự kiện.
 */
export async function requeueReauthMail(mailId: string, now: Date): Promise<'requeued' | 'stale' | 'failed' | 'skipped'> {
  requireCompanyId('requeueReauthMail');
  const mail = await findReauthMail(mailId, { forUpdate: true });
  if (!mail || mail.outcome || mail.queuedAt.getTime() > now.getTime() - REAUTH_MAIL_RETRY_AFTER_MS) return 'skipped';
  const row = await findShopRow(mail.shopId);
  if (!row || !isCurrentMail(mail, await milestoneOf(row, now))) {
    await finishReauthMail(mail.id, 'stale');
    return 'stale';
  }
  if (mail.attempts >= REAUTH_MAIL_MAX_ATTEMPTS) {
    await finishReauthMail(mail.id, 'failed');
    logger.error({ mailId, shopId: mail.shopId, attempts: mail.attempts }, 'bỏ thư báo mất uỷ quyền: hết lượt xếp lại');
    return 'failed';
  }
  if (!(await bumpReauthMailAttempt(mail, now))) return 'skipped';
  await publish(mail);
  return 'requeued';
}

/**
 * Một lượt của việc nền: xếp mốc tới hạn của mọi gian hàng có thể tới mốc, rồi xếp lại thư chưa gửi được. Mỗi gian hàng,
 * mỗi thư một giao dịch; lỗi một chỗ không chặn chỗ khác. Trả số thư vừa xếp mới.
 */
export async function queueReauthMailsOnce(now = new Date()): Promise<number> {
  let queued = 0;
  for (const shop of await findReauthMailCandidatesAnyCompany()) {
    try {
      if (await withCompany(shop.companyId, () => queueDueReauthMail(shop.id, now))) queued++;
    } catch (err) {
      logger.error({ err, shopId: shop.id }, 'xếp thư báo mất uỷ quyền lỗi');
    }
  }
  for (const mail of await findPendingReauthMailsAnyCompany(new Date(now.getTime() - REAUTH_MAIL_RETRY_AFTER_MS))) {
    try {
      await withCompany(mail.companyId, () => requeueReauthMail(mail.id, now));
    } catch (err) {
      logger.error({ err, mailId: mail.id }, 'xếp lại thư báo mất uỷ quyền lỗi');
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
 * Consumer `channel.shop_reauth_mail`: chạy trong `withCompany` của sự kiện (consumer `shared`). Khoá dòng thư để sự kiện
 * gốc và bản xếp lại của cùng thư không cùng gửi; thư đã có kết quả thì bỏ. Thư đã cũ (gian hàng đã nối lại, đã ngắt,
 * hạn đã đổi hẳn, mốc sau đã thay) thì ghi `stale`; hạn chỉ lệch vài giây sau khi làm mới token vẫn gửi. Người nhận: CEO,
 * Admin đang hoạt động của công ty, không gồm quản trị nền tảng; một thư gửi chung mọi người nhận để lỗi tạm thử lại
 * không thành gửi trùng cho người đã nhận. SMTP lỗi tạm thì ném để outbox thử lại (hết lượt thì việc nền xếp lại); lỗi
 * vĩnh viễn thì ghi `failed` và log, không thử lại.
 */
export async function handleReauthMail(event: ReauthMailEvent): Promise<void> {
  const { mailId, shopId } = event.payload;
  const log = { eventId: event.eventId, mailId, shopId };
  const mail = await findReauthMail(mailId, { forUpdate: true });
  if (!mail || mail.outcome) {
    logger.info({ ...log, outcome: mail?.outcome }, 'bỏ sự kiện thư báo mất uỷ quyền: thư đã xong');
    return;
  }
  const row = await findShopRow(shopId);
  const lostAt = row ? await lostAtOf(row) : null;
  const deadline = row ? authDeadline(row.authExpiresAt, row.refreshExpiresAt) : null;
  const due = row ? dueReauthMail({ status: row.status, deadline, lostAt }, new Date()) : null;
  if (!row || !isCurrentMail(mail, due)) {
    await finishReauthMail(mail.id, 'stale');
    logger.info({ ...log, status: row?.status }, 'bỏ thư báo mất uỷ quyền: gian hàng đã đổi');
    return;
  }
  const recipients = await activeMemberEmailsWithRoles([BUILTIN_ROLES.ceo.id, BUILTIN_ROLES.admin.id]);
  if (recipients.length === 0) {
    await finishReauthMail(mail.id, 'failed');
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
      await finishReauthMail(mail.id, 'failed');
      logger.error({ ...log, smtpCode: err.smtpCode }, 'gửi thư báo mất uỷ quyền lỗi vĩnh viễn');
      return;
    }
    throw err;
  }
  await finishReauthMail(mail.id, 'sent');
  logger.info({ ...log, stage: mail.stage, seq: mail.seq, recipients: recipients.length }, 'đã gửi thư báo mất uỷ quyền');
}
