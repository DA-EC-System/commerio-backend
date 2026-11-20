// Đăng ký công ty hai bước (#459, Documents/21 mục 2.1): hằng số như mã mời (mục 3.1), luật thuần, không I/O.
// CHECK `registrations_otp_counters_range` ghi cứng 5 cho hai bộ đếm: đổi hằng số thì sửa cả CHECK.
import { sha256Hex } from '../../../../shared/crypto/codes.ts';

export const REGISTRATION_OTP_LENGTH = 6;
export const REGISTRATION_OTP_TTL_SECONDS = 300;
export const REGISTRATION_OTP_MAX_ATTEMPTS = 5;
export const REGISTRATION_RESEND_SECONDS = 60;
/** Số thư mã tối đa của một lần đăng ký. */
export const REGISTRATION_OTP_MAX_SENDS = 5;
/** Lần đăng ký sống 30 phút từ lúc gửi form. */
export const REGISTRATION_TTL_SECONDS = 30 * 60;
/** Trần theo email, đếm trong CSDL ở cả hai nhánh (email mới, email đã có tài khoản). */
export const EMAIL_LIVE_REGISTRATIONS_MAX = 3;
export const EMAIL_MAILS_PER_HOUR_MAX = 5;
/** Thư "email đã có tài khoản": tối đa một thư mỗi email trong khoảng này. */
export const ACCOUNT_NOTICE_INTERVAL_SECONDS = 24 * 3600;
/** Việc gửi thư cũ hơn mốc này thì bỏ (mã gửi trễ đã vô ích). */
export const REGISTRATION_MAIL_MAX_AGE_SECONDS = 300;
/** Dòng tạo quá mốc này thì việc nền xoá (đã hết hạn, hết tác dụng đếm trần). */
export const REGISTRATION_RETENTION_SECONDS = ACCOUNT_NOTICE_INTERVAL_SECONDS;

/** DB chỉ giữ bản băm; gắn id lần đăng ký để cùng mã ở hai lần đăng ký không ra cùng bản băm. */
export const registrationOtpHash = (code: string, registrationId: string): string =>
  sha256Hex(`registration:${code}:${registrationId}`);

export function isStaleRegistrationMail(requestedAt: string, now: Date): boolean {
  return now.getTime() - Date.parse(requestedAt) > REGISTRATION_MAIL_MAX_AGE_SECONDS * 1000;
}

/** Miền thử của e2e (đã kiểm ở `config/env.ts`); so đúng phần sau `@` cuối cùng, không so đuôi. */
export function isTestEmail(email: string, testDomain: string | undefined): boolean {
  if (!testDomain) return false;
  const at = email.lastIndexOf('@');
  return at > 0 && email.slice(at + 1).toLowerCase() === testDomain;
}

/** Số giây phải chờ trước khi xin mã lại, tối thiểu 0. */
export function resendAfterSeconds(otpRequestedAt: Date, now: Date): number {
  const wait = Math.ceil((otpRequestedAt.getTime() + REGISTRATION_RESEND_SECONDS * 1000 - now.getTime()) / 1000);
  return Math.min(REGISTRATION_RESEND_SECONDS, Math.max(0, wait));
}
