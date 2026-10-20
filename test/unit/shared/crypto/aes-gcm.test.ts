import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CipherError, decryptBytes, encryptBytes } from '#src/shared/crypto/aes-gcm.ts';

const key = randomBytes(32);

// AES-256-GCM dùng chung cho khoá cổng (payment) và secret 2FA (staff), #7 spec 6.2.
describe('encryptBytes, decryptBytes', () => {
  it('giải mã lại đúng bản rõ khi cùng AAD', () => {
    const enc = encryptBytes(Buffer.from('bí mật'), 'totp:a', key);
    expect(decryptBytes(enc, 'totp:a', key).toString()).toBe('bí mật');
  });

  it('AAD khác thì ném CipherError', () => {
    const enc = encryptBytes(Buffer.from('bí mật'), 'totp:a', key);
    expect(() => decryptBytes(enc, 'totp:b', key)).toThrow(CipherError);
  });

  it('sai khoá thì ném CipherError', () => {
    const enc = encryptBytes(Buffer.from('bí mật'), 'totp:a', key);
    expect(() => decryptBytes(enc, 'totp:a', randomBytes(32))).toThrow(CipherError);
  });

  it('bản mã bị sửa một byte thì ném CipherError', () => {
    const enc = encryptBytes(Buffer.from('bí mật'), 'totp:a', key);
    enc[enc.length - 1]! ^= 0xff;
    expect(() => decryptBytes(enc, 'totp:a', key)).toThrow(CipherError);
  });

  it('byte phiên bản khác 1 thì ném CipherError', () => {
    const enc = encryptBytes(Buffer.from('bí mật'), 'totp:a', key);
    enc[0] = 2;
    expect(() => decryptBytes(enc, 'totp:a', key)).toThrow(CipherError);
  });

  it('bản mã quá ngắn thì ném CipherError', () => {
    expect(() => decryptBytes(Buffer.from([1, 2, 3]), 'totp:a', key)).toThrow(CipherError);
  });

  // Bản mã do credentials-cipher.ts của payment ghi trước khi tách ra shared (khoá toàn byte 7).
  it('đọc được bản mã payment đã ghi trước khi tách', () => {
    const stored = Buffer.from('AYuJukiUfA1/P+RKwRTW0VZBi+H9rpCEx06k4IiefFMph8ehEBWPSuZiZ2e2WA==', 'base64');
    const plain = decryptBytes(stored, 'c1:momo', Buffer.alloc(32, 7));
    expect(JSON.parse(plain.toString('utf8'))).toEqual({ secretKey: 'S' });
  });
});
