import { describe, expect, it } from 'vitest';
import { joinLimits } from '#src/modules/staff/api/join-limits.ts';

const MIN15 = 15 * 60_000;
const HOUR = 60 * 60_000;

// Giới hạn tần suất của /join/* (#7 spec 6.11), nhân `JOIN_RATE_LIMIT_SCALE`.
describe('joinLimits', () => {
  it('scale 1 đúng bảng spec 6.11', () => {
    expect(joinLimits(1)).toEqual({
      check: { limit: 60, windowMs: MIN15 },
      otpIp: { limit: 10, windowMs: MIN15 },
      otpEmail: { limit: 5, windowMs: HOUR },
      otpInvitation: { limit: 6, windowMs: HOUR },
      verifyIp: { limit: 30, windowMs: MIN15 },
      verifyInvitation: { limit: 10, windowMs: MIN15 },
      completeIp: { limit: 20, windowMs: MIN15 },
      completeEmail: { limit: 5, windowMs: MIN15 },
      twoFactorInvitation: { limit: 5, windowMs: MIN15 },
    });
  });

  it('nhân ngưỡng theo scale, giữ nguyên cửa sổ', () => {
    expect(joinLimits(1000).otpIp).toEqual({ limit: 10_000, windowMs: MIN15 });
  });

  it('scale nhỏ vẫn cho ít nhất một lần', () => {
    for (const { limit } of Object.values(joinLimits(0.01))) expect(limit).toBe(1);
  });
});
