import { describe, expect, it } from 'vitest';
import {
  generateRecoveryCodes,
  normalizeRecoveryCode,
  randomDigits,
  safeEqualHex,
  sha256Hex,
} from '#src/shared/crypto/codes.ts';

describe('randomDigits', () => {
  it('randomDigits(6) luôn đủ 6 chữ số, kể cả số 0 đầu', () => {
    for (let i = 0; i < 1000; i++) expect(randomDigits(6)).toMatch(/^\d{6}$/);
  });
});

describe('sha256Hex', () => {
  it('ra 64 ký tự hex, cùng đầu vào cùng kết quả', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('safeEqualHex', () => {
  it('trả true khi hai chuỗi giống nhau', () => {
    expect(safeEqualHex(sha256Hex('a'), sha256Hex('a'))).toBe(true);
  });

  it('trả false khi khác nội dung', () => {
    expect(safeEqualHex(sha256Hex('a'), sha256Hex('b'))).toBe(false);
  });

  it('safeEqualHex trả false khi độ dài khác, không ném', () => {
    expect(safeEqualHex('ab', 'abcd')).toBe(false);
  });
});

// Mã khôi phục 2FA (#7 [D]): 2 mã mỗi tài khoản (Thành và Khang chốt 21/10/2026), DB chỉ giữ bản băm.
describe('mã khôi phục', () => {
  it('đủ số mã, mỗi mã 10 ký tự base32, không trùng nhau', () => {
    const codes = generateRecoveryCodes(50);
    expect(codes).toHaveLength(50);
    for (const code of codes) expect(code).toMatch(/^[A-Z2-7]{10}$/);
    expect(new Set(codes).size).toBe(50);
  });

  it('người dùng gõ chữ thường, gạch nối, khoảng trắng vẫn khớp', () => {
    expect(normalizeRecoveryCode(' abcde-fgh23 ')).toBe('ABCDEFGH23');
    expect(normalizeRecoveryCode('ABCDE FGH23')).toBe('ABCDEFGH23');
  });
});
