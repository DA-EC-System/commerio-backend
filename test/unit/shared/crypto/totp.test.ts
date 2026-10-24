import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  matchTotp,
  TOTP_STEP_SECONDS,
  totpAt,
  totpUri,
} from '#src/shared/crypto/totp.ts';

// RFC 6238 phụ lục B: SHA-1, secret ASCII "12345678901234567890". Mã 6 số là 6 số cuối của mã 8 số trong bảng.
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const stepAt = (seconds: number) => Math.floor(seconds / TOTP_STEP_SECONDS);

describe('TOTP (RFC 6238)', () => {
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ])('thời điểm %i giây cho mã %s', (seconds, code) => {
    expect(totpAt(RFC_SECRET, stepAt(seconds))).toBe(code);
  });

  it('matchTotp nhận lệch ±1 bước, trả đúng bước của mã', () => {
    const step = stepAt(1234567890);
    const code = totpAt(RFC_SECRET, step);
    for (const delta of [-1, 0, 1]) {
      expect(matchTotp(RFC_SECRET, code, (step + delta) * TOTP_STEP_SECONDS * 1000 + 5000)).toBe(step);
    }
  });

  it('matchTotp từ chối lệch 2 bước, mã sai, mã sai dạng', () => {
    const step = stepAt(1234567890);
    const code = totpAt(RFC_SECRET, step);
    const now = step * TOTP_STEP_SECONDS * 1000;
    expect(matchTotp(RFC_SECRET, code, now + 2 * TOTP_STEP_SECONDS * 1000)).toBeNull();
    expect(matchTotp(RFC_SECRET, code, now - 2 * TOTP_STEP_SECONDS * 1000)).toBeNull();
    expect(matchTotp(RFC_SECRET, code === '000000' ? '111111' : '000000', now)).toBeNull();
    for (const bad of ['', '12345', '1234567', '12a456', ' 00592']) expect(matchTotp(RFC_SECRET, bad, now)).toBeNull();
  });

  it('base32 theo RFC 4648, không đệm', () => {
    expect(base32Encode(RFC_SECRET)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')).toEqual(RFC_SECRET);
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('mzxw6ytboi')).toEqual(Buffer.from('foobar'));
  });

  it('secret mới: 20 byte ngẫu nhiên, base32 32 ký tự giải ra đúng byte', () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a.raw).toHaveLength(20);
    expect(a.base32).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(a.base32)).toEqual(a.raw);
    expect(a.base32).not.toBe(b.base32);
  });

  it('otpauth URI theo Documents/21 mục 2.1', () => {
    expect(totpUri({ issuer: 'Commerio', label: 'a@x.vn', secretBase32: 'GEZDGNBV' })).toBe(
      'otpauth://totp/Commerio:a%40x.vn?secret=GEZDGNBV&issuer=Commerio',
    );
  });
});
