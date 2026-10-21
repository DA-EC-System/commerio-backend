// Mã OTP xác minh email của người được mời (#7 [C]). CHECK `invitations_otp_counters_range` (migration 0018)
// ghi cứng 5 cho hai bộ đếm: đổi OTP_MAX_ATTEMPTS, OTP_MAX_SENDS thì sửa cả CHECK.
import { sha256Hex } from '../../../shared/crypto/codes.ts';

export const OTP_LENGTH = 6;
export const OTP_TTL_SECONDS = 300;
/** Sai đủ số lần này thì mã hết hiệu lực, phải xin mã mới. */
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_SECONDS = 60;
/** Số lần gửi tối đa của một link. */
export const OTP_MAX_SENDS = 5;
/** Sự kiện xin mã cũ hơn mốc này thì consumer bỏ, không gửi thư (mã gửi trễ đã vô ích). */
export const OTP_EVENT_MAX_AGE_SECONDS = 300;

/** DB chỉ giữ bản băm; gắn id lời mời để cùng mã ở hai lời mời không ra cùng bản băm. */
export const otpHash = (code: string, invitationId: string): string => sha256Hex(`${code}:${invitationId}`);

export function isStaleOtpEvent(requestedAt: string, now: Date): boolean {
  return now.getTime() - Date.parse(requestedAt) > OTP_EVENT_MAX_AGE_SECONDS * 1000;
}
