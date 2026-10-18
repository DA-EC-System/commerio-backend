import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptCredentials, encryptCredentials } from '#src/modules/payment/service/credentials-cipher.ts';

const key = randomBytes(32);
const creds = { partnerCode: 'MOMO', accessKey: 'ACCESS-KEY-123', secretKey: 'SECRET-KEY-XYZ-789' };

// Khoá cổng mã hoá AES-256-GCM, gắn với (công ty, cổng) (#23 AC-10, AC-11, plan A2).
describe('mã hoá khoá cổng', () => {
  it('giải mã ra đúng các ô đã mã hoá, bản mã không chứa giá trị gốc', () => {
    const enc = encryptCredentials(creds, 'c1:momo', key);
    expect(decryptCredentials(enc, 'c1:momo', key)).toEqual(creds);
    for (const value of Object.values(creds)) expect(enc.includes(Buffer.from(value))).toBe(false);
  });

  it('hai lần mã hoá cùng nội dung ra hai bản mã khác nhau (iv ngẫu nhiên)', () => {
    expect(encryptCredentials(creds, 'c1:momo', key).equals(encryptCredentials(creds, 'c1:momo', key))).toBe(false);
  });

  it('đổi một byte bản mã thì giải mã thất bại', () => {
    const enc = encryptCredentials(creds, 'c1:momo', key);
    enc[enc.length - 1]! ^= 0xff;
    expect(() => decryptCredentials(enc, 'c1:momo', key)).toThrow();
  });

  it('bản mã chép sang công ty khác hoặc cổng khác thì không giải mã được', () => {
    const enc = encryptCredentials(creds, 'c1:momo', key);
    expect(() => decryptCredentials(enc, 'c2:momo', key)).toThrow();
    expect(() => decryptCredentials(enc, 'c1:zalopay', key)).toThrow();
  });

  it('sai khoá chủ thì không giải mã được', () => {
    const enc = encryptCredentials(creds, 'c1:momo', key);
    expect(() => decryptCredentials(enc, 'c1:momo', randomBytes(32))).toThrow();
  });

  it('chưa đặt PAYMENT_CREDENTIALS_KEY thì báo 500 payment_credentials_key_missing', () => {
    // vitest.config.ts không đặt biến này.
    expect(() => encryptCredentials(creds, 'c1:momo')).toThrow(
      expect.objectContaining({ status: 500, code: 'payment_credentials_key_missing' }),
    );
  });
});
