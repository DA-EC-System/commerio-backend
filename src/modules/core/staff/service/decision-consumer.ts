// Consumer thư của luồng mời sau bước nộp (Documents/21 mục 3.1): `staff.invitation_submitted` báo người có quyền
// duyệt, `staff.invitation_decided` báo người đăng ký kết quả. Chạy trong withCompany của sự kiện (consumer `shared`).
// Sự kiện không mang email, họ tên: đọc dòng lời mời lúc gửi, trạng thái đã khác thì bỏ. SMTP lỗi tạm thì ném để outbox
// thử lại; lỗi vĩnh viễn log `error`, không ném (cảnh báo `CommerioMailPermanentFailure`): việc nộp, duyệt đã xong.
import { logger } from '../../../../shared/logger.ts';
import { MailError, type MailMessage, sendMail } from '../../../../shared/mail/index.ts';
import { findRolesWithPermissions } from '../../access/index.ts';
import { type EventEnvelope, type EventPayload, getCompanies } from '../../platform/index.ts';
import { findAccountSummaries } from '../repository/accounts.ts';
import { findInvitation } from '../repository/invitations.ts';
import { renderApprovedMail, renderRejectedMail, renderSubmittedMail } from './decision-mail.ts';
import { activeMemberEmailsWithPermission } from './recipients.ts';
import { loginLink, pendingQueueLink } from './web-links.ts';

export const SUBMITTED_CONSUMER = 'staff-invitation-submitted-mail';
export const DECIDED_CONSUMER = 'staff-invitation-decided-mail';

/** Quyền duyệt lời mời (Documents/21 mục 3.1); người có quyền này nhận thư báo có yêu cầu chờ. */
const APPROVER_PERMISSION = 'identity.account.manage';

type Submitted = EventEnvelope<'staff.invitation_submitted', EventPayload<'staff.invitation_submitted'>>;
type Decided = EventEnvelope<'staff.invitation_decided', EventPayload<'staff.invitation_decided'>>;

async function companyName(companyId: string): Promise<string> {
  return (await getCompanies([companyId])).get(companyId)?.name ?? 'Commerio';
}

async function deliver(message: MailMessage, template: string, log: Record<string, unknown>): Promise<void> {
  try {
    await sendMail(message, template);
  } catch (err) {
    if (err instanceof MailError && err.kind === 'permanent') {
      logger.error({ ...log, template, smtpCode: err.smtpCode }, 'gửi thư lời mời lỗi vĩnh viễn');
      return;
    }
    throw err;
  }
  logger.info({ ...log, template }, 'đã gửi thư lời mời');
}

export async function handleInvitationSubmitted(event: Submitted): Promise<void> {
  const { invitationId } = event.payload;
  const log = { eventId: event.eventId, invitationId };
  const row = await findInvitation(invitationId);
  if (!row || row.status !== 'pending' || !row.email || !row.fullName) {
    logger.info(log, 'bỏ thư báo người duyệt: lời mời không còn chờ duyệt');
    return;
  }
  const recipients = await activeMemberEmailsWithPermission(APPROVER_PERMISSION);
  if (recipients.length === 0) {
    logger.info(log, 'bỏ thư báo người duyệt: công ty không còn ai duyệt được');
    return;
  }
  const roles = await findRolesWithPermissions(row.roleIds);
  const mail = renderSubmittedMail({
    companyName: await companyName(row.companyId),
    fullName: row.fullName,
    email: row.email,
    roleNames: roles.map((r) => r.name).sort((x, y) => x.localeCompare(y, 'vi')),
    queueLink: pendingQueueLink(),
  });
  // Một thư, người duyệt thấy nhau trong ô người nhận: đều là quản lý cùng công ty.
  await deliver({ to: recipients.join(', '), ...mail }, 'invitation_submitted', { ...log, recipients: recipients.length });
}

export async function handleInvitationDecided(event: Decided): Promise<void> {
  const { invitationId, decision } = event.payload;
  const log = { eventId: event.eventId, invitationId, decision };
  const row = await findInvitation(invitationId);
  if (!row || row.status !== decision || !row.email || !row.fullName) {
    logger.info(log, 'bỏ thư báo kết quả: trạng thái lời mời đã khác');
    return;
  }
  const name = await companyName(row.companyId);
  if (decision === 'rejected') {
    await deliver({ to: row.email, ...renderRejectedMail({ companyName: name, fullName: row.fullName }) }, 'invitation_rejected', log);
    return;
  }
  // Tài khoản tạo lúc duyệt (email mới) sinh sau lúc nộp; tài khoản đã có thì có trước (như `existingAccount` của API).
  const [account] = row.accountId ? await findAccountSummaries([row.accountId]) : [];
  const existingAccount = !!account && !!row.submittedAt && account.createdAt < row.submittedAt;
  const mail = renderApprovedMail({
    companyName: name,
    fullName: row.fullName,
    email: row.email,
    existingAccount,
    loginLink: loginLink(),
  });
  await deliver({ to: row.email, ...mail }, 'invitation_approved', log);
}
