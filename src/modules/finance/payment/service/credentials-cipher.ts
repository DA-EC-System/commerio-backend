// Mã hoá khoá cổng lưu ở `finance.gateway_configs.credentials_enc` (Documents/21 T4, T11; plan #23 A2).
// AES-256-GCM (`shared/crypto/aes-gcm.ts`), khoá chủ `PAYMENT_CREDENTIALS_KEY`. AAD = "<companyId>:<gateway>":
// bản mã chép sang dòng khác không giải mã được. Bản rõ là JSON các ô.
import { env } from '../../../../shared/config/env.ts';
import { decryptBytes, encryptBytes } from '../../../../shared/crypto/aes-gcm.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import type { Credentials } from '../domain/gateways.ts';

function masterKey(): Buffer {
  if (!env.PAYMENT_CREDENTIALS_KEY) {
    throw new AppError(500, 'payment_credentials_key_missing', 'Máy chủ chưa đặt PAYMENT_CREDENTIALS_KEY để mã hoá khoá cổng');
  }
  return Buffer.from(env.PAYMENT_CREDENTIALS_KEY, 'base64');
}

export function encryptCredentials(credentials: Credentials, aad: string, key: Buffer = masterKey()): Buffer {
  return encryptBytes(Buffer.from(JSON.stringify(credentials), 'utf8'), aad, key);
}

const CREDENTIALS_UNREADABLE = 'payment_credentials_unreadable';

/** Lỗi giải mã của `decryptCredentials` (#63 B6); thiếu khoá chủ không tính. */
export const isCredentialsUnreadable = (err: unknown): boolean =>
  err instanceof AppError && err.code === CREDENTIALS_UNREADABLE;

/**
 * Ném 500 `payment_credentials_unreadable` khi bản mã bị sửa, sai phiên bản, sai khoá chủ hoặc không thuộc đúng
 * (công ty, cổng). Không giữ lỗi gốc của crypto.
 */
export function decryptCredentials(data: Buffer, aad: string, key: Buffer = masterKey()): Credentials {
  try {
    return JSON.parse(decryptBytes(data, aad, key).toString('utf8')) as Credentials;
  } catch {
    throw new AppError(500, CREDENTIALS_UNREADABLE, 'Khoá cổng đã lưu không giải mã được (khoá chủ đã đổi hoặc bản mã hỏng)');
  }
}
