import { describe, expect, it } from 'vitest';
import {
  isStaleOtpEvent,
  OTP_EVENT_MAX_AGE_SECONDS,
  OTP_LENGTH,
  OTP_MAX_ATTEMPTS,
  OTP_MAX_SENDS,
  OTP_RESEND_SECONDS,
  OTP_TTL_SECONDS,
  otpHash,
} from '#src/modules/staff/domain/otp.ts';
import { sha256Hex } from '#src/shared/crypto/codes.ts';

const ID = '7d3f6c2a-1b4e-4f5a-9c8d-0e1f2a3b4c5d';

describe('OTP lời mời', () => {
  it('hằng số theo spec #7', () => {
    expect({
      OTP_LENGTH,
      OTP_TTL_SECONDS,
      OTP_MAX_ATTEMPTS,
      OTP_RESEND_SECONDS,
      OTP_MAX_SENDS,
      OTP_EVENT_MAX_AGE_SECONDS,
    }).toEqual({
      OTP_LENGTH: 6,
      OTP_TTL_SECONDS: 300,
      OTP_MAX_ATTEMPTS: 5,
      OTP_RESEND_SECONDS: 60,
      OTP_MAX_SENDS: 5,
      OTP_EVENT_MAX_AGE_SECONDS: 300,
    });
  });

  it('băm mã kèm id lời mời: cùng mã ở hai lời mời ra hai bản băm', () => {
    expect(otpHash('123456', ID)).toBe(sha256Hex(`123456:${ID}`));
    expect(otpHash('123456', ID)).not.toBe(otpHash('123456', '00000000-0000-4000-8000-000000000000'));
  });

  it('sự kiện cũ hơn 300 giây bị bỏ; đúng 300 giây vẫn dùng', () => {
    const requestedAt = '2026-10-21T00:00:00.000Z';
    expect(isStaleOtpEvent(requestedAt, new Date('2026-10-21T00:05:00.000Z'))).toBe(false);
    expect(isStaleOtpEvent(requestedAt, new Date('2026-10-21T00:05:01.000Z'))).toBe(true);
  });
});
