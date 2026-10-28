// Việc nền của staff trong worker: consumer gửi thư OTP lời mời (#7 [C]).
import { registerConsumer } from '../../platform/index.ts';
import { handleOtpRequested, OTP_CONSUMER } from './otp-consumer.ts';

export async function startStaffBackground(): Promise<() => Promise<void>> {
  registerConsumer('staff.invitation_otp_requested', handleOtpRequested, { consumer: OTP_CONSUMER });
  // Consumer dừng cùng outbox của platform.
  return async () => {};
}
