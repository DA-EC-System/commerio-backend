// Consumer `staff.invitation_otp_requested` (#7 [C], spec 6.7 "Consumer OTP"): sinh mã trong worker, chỉ lưu bản băm,
// gửi thư. Chạy trong withCompany của sự kiện, cùng giao dịch với `processed_events` (consumer `shared`), nên lỗi
// ném ra thì mã chưa ghi và outbox thử lại.
import { randomDigits } from '../../../shared/crypto/codes.ts';
import { logger } from '../../../shared/logger.ts';
import { MailError, sendMail } from '../../../shared/mail/index.ts';
import { type EventEnvelope, type EventPayload, getCompanies } from '../../platform/index.ts';
import { isStaleOtpEvent, OTP_LENGTH, otpHash } from '../domain/otp.ts';
import { findInvitation, storeOtpHash } from '../repository/invitations.ts';
import { countOtpRequest } from './metrics.ts';
import { renderOtpMail } from './otp-mail.ts';

export const OTP_CONSUMER = 'staff-invitation-otp';
const TEMPLATE = 'invitation_otp';

type OtpRequested = EventEnvelope<'staff.invitation_otp_requested', EventPayload<'staff.invitation_otp_requested'>>;

export async function handleOtpRequested(event: OtpRequested): Promise<void> {
  const { invitationId, requestedAt } = event.payload;
  const log = { eventId: event.eventId, invitationId };
  // Mã sống 5 phút: thư tới trễ hơn thế thì vô ích, người dùng đã xin lại.
  if (isStaleOtpEvent(requestedAt, new Date())) {
    countOtpRequest('stale');
    logger.info(log, 'bỏ sự kiện xin mã OTP đã cũ');
    return;
  }
  const row = await findInvitation(invitationId, { forUpdate: true });
  // Bỏ khi: không còn dòng; đã nộp, đã quyết; đã có lần xin sau (`otp_requested_at` khác); đã gửi thư cho lần xin
  // này (sự kiện giao lại: mã đã ghi).
  const current =
    row &&
    (row.status === 'open' || row.status === 'claimed') &&
    row.otpRequestedAt?.getTime() === Date.parse(requestedAt) &&
    row.otpHash === null;
  if (!current || !row.email || !row.fullName) {
    countOtpRequest('skipped');
    logger.info(log, 'bỏ sự kiện xin mã OTP: lời mời đã đổi');
    return;
  }
  const company = (await getCompanies([row.companyId])).get(row.companyId);
  const code = randomDigits(OTP_LENGTH);
  await storeOtpHash(row.id, otpHash(code, row.id));
  const mail = renderOtpMail({ fullName: row.fullName, companyName: company?.name ?? 'Commerio', code });
  try {
    await sendMail({ to: row.email, ...mail }, TEMPLATE);
  } catch (err) {
    // Lỗi vĩnh viễn (hết hạn mức Gmail, chưa cấu hình SMTP): thử lại vô ích; người dùng xin mã lại sau 60 giây.
    if (err instanceof MailError && err.kind === 'permanent') {
      logger.error({ ...log, smtpCode: err.smtpCode }, 'gửi thư OTP lỗi vĩnh viễn');
      return;
    }
    throw err;
  }
  countOtpRequest('sent');
  logger.info(log, 'đã gửi thư OTP');
}
