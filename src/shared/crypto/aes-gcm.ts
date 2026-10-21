// AES-256-GCM dùng chung: khoá cổng thanh toán (payment) và secret xác thực hai lớp (staff, #7).
// Định dạng: 1 byte phiên bản | iv 12 byte | tag 16 byte | bản mã. AAD gắn bản mã với đúng dòng của nó,
// chép sang dòng khác thì không giải mã được.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = 1 + IV_LENGTH + TAG_LENGTH;

/** Bản mã bị sửa, sai phiên bản, sai khoá hoặc sai AAD. Không giữ lỗi gốc của crypto. */
export class CipherError extends Error {
  constructor() {
    super('Không giải mã được dữ liệu đã lưu');
    this.name = 'CipherError';
  }
}

export function encryptBytes(plain: Buffer, aad: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

export function decryptBytes(data: Buffer, aad: string, key: Buffer): Buffer {
  try {
    if (data.length < HEADER_LENGTH || data[0] !== VERSION) throw new Error('sai định dạng');
    const iv = data.subarray(1, 1 + IV_LENGTH);
    const tag = data.subarray(1 + IV_LENGTH, HEADER_LENGTH);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data.subarray(HEADER_LENGTH)), decipher.final()]);
  } catch {
    throw new CipherError();
  }
}
