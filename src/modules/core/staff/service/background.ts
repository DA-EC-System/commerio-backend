// Việc nền của staff trong worker: consumer gửi thư của luồng mời (#7 [C], Documents/21 mục 3.1), dọn nháp lời mời quá hạn.
import { registerConsumer } from '../../platform/index.ts';
import {
  DECIDED_CONSUMER,
  handleInvitationDecided,
  handleInvitationSubmitted,
  SUBMITTED_CONSUMER,
} from './decision-consumer.ts';
import { startInvitationPurge } from './invitation-purge.ts';
import { handleOtpRequested, OTP_CONSUMER } from './otp-consumer.ts';

export async function startStaffBackground(): Promise<() => Promise<void>> {
  registerConsumer('staff.invitation_otp_requested', handleOtpRequested, { consumer: OTP_CONSUMER });
  registerConsumer('staff.invitation_submitted', handleInvitationSubmitted, { consumer: SUBMITTED_CONSUMER });
  registerConsumer('staff.invitation_decided', handleInvitationDecided, { consumer: DECIDED_CONSUMER });
  await startInvitationPurge();
  // Consumer dừng cùng outbox của platform, pg-boss dừng chung ở platform.
  return async () => {};
}
