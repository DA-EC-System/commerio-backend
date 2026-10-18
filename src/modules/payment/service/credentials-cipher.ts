// Mã hoá khoá cổng lưu ở `payment.gateway_configs.credentials_enc` (Documents/21 T4, T11; plan #23 A2).
// AES-256-GCM, khoá chủ `PAYMENT_CREDENTIALS_KEY`. AAD = "<companyId>:<gateway>": bản mã chép sang dòng khác không giải mã được.
// Định dạng: 1 byte phiên bản | iv 12 byte | tag 16 byte | bản mã của JSON các ô.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../../../shared/config/env.ts';
import { AppError } from '../../../shared/errors/app-error.ts';
import type { Credentials } from '../domain/gateways.ts';

const VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function masterKey(): Buffer {
  if (!env.PAYMENT_CREDENTIALS_KEY) {
    throw new AppError(500, 'payment_credentials_key_missing', 'Máy chủ chưa đặt PAYMENT_CREDENTIALS_KEY để mã hoá khoá cổng');
  }
  return Buffer.from(env.PAYMENT_CREDENTIALS_KEY, 'base64');
}

export function encryptCredentials(credentials: Credentials, aad: string, key: Buffer = masterKey()): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

/** Ném lỗi khi bản mã bị sửa, sai khoá chủ hoặc không thuộc đúng (công ty, cổng). */
export function decryptCredentials(data: Buffer, aad: string, key: Buffer = masterKey()): Credentials {
  if (data[0] !== VERSION) throw new Error('Bản mã khoá cổng không đúng phiên bản');
  const iv = data.subarray(1, 1 + IV_LENGTH);
  const tag = data.subarray(1 + IV_LENGTH, 1 + IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data.subarray(1 + IV_LENGTH + TAG_LENGTH)), decipher.final()]);
  return JSON.parse(plain.toString('utf8')) as Credentials;
}
