import { describe, expect, it } from 'vitest';
import {
  isStaleRegistrationMail,
  isTestEmail,
  registrationOtpHash,
  resendAfterSeconds,
} from '#src/modules/core/identity/domain/registration.ts';

describe('luật đăng ký công ty (#459)', () => {
  it('miền thử so đúng phần sau @ cuối, không so đuôi', () => {
    expect(isTestEmail('a@e2e.test', 'e2e.test')).toBe(true);
    expect(isTestEmail('a@E2E.TEST', 'e2e.test')).toBe(true);
    expect(isTestEmail('a@x.e2e.test', 'e2e.test')).toBe(false);
    expect(isTestEmail('a@e2e.test.vn', 'e2e.test')).toBe(false);
    expect(isTestEmail('a@e2e.test', undefined)).toBe(false);
  });

  it('bản băm khác nhau theo lần đăng ký', () => {
    expect(registrationOtpHash('123456', 'a')).not.toBe(registrationOtpHash('123456', 'b'));
  });

  it('chờ xin lại tối đa 60 giây, không âm', () => {
    const at = new Date('2026-11-20T00:00:00Z');
    expect(resendAfterSeconds(at, at)).toBe(60);
    expect(resendAfterSeconds(at, new Date(at.getTime() + 59_500))).toBe(1);
    expect(resendAfterSeconds(at, new Date(at.getTime() + 61_000))).toBe(0);
  });

  it('việc gửi thư quá 5 phút là cũ', () => {
    const now = new Date('2026-11-20T00:10:00Z');
    expect(isStaleRegistrationMail('2026-11-20T00:04:59Z', now)).toBe(true);
    expect(isStaleRegistrationMail('2026-11-20T00:05:30Z', now)).toBe(false);
  });
});
