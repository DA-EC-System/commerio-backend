// Secret TOTP và mã khôi phục (#7 [D], D40), dùng chung cho thiết lập 2FA của tài khoản (identity) và lúc tham gia qua
// link (staff). Secret mã hoá AES-256-GCM bằng `TOTP_ENCRYPTION_KEY`, AAD gắn với dòng: `totp:<accountId>` hoặc
// `totp:<invitationId>`, nên bản mã chép sang dòng khác không giải được.
import { env } from '../../../shared/config/env.ts';
import { decryptBytes, encryptBytes } from '../../../shared/crypto/aes-gcm.ts';
import { generateRecoveryCodes, normalizeRecoveryCode, sha256Hex } from '../../../shared/crypto/codes.ts';
import { generateTotpSecret, totpUri } from '../../../shared/crypto/totp.ts';

/** Thành và Khang chốt 21/10/2026 (giảm từ 10). */
export const RECOVERY_CODE_COUNT = 2;
const ISSUER = 'Commerio';

export const totpAad = (rowId: string) => `totp:${rowId}`;

function key(): Buffer {
  // env đã đòi khoá khi TWO_FACTOR_MODE=required; tới đây mà thiếu là cấu hình sai.
  if (!env.TOTP_ENCRYPTION_KEY) throw new Error('Chưa đặt TOTP_ENCRYPTION_KEY');
  return Buffer.from(env.TOTP_ENCRYPTION_KEY, 'base64');
}

export const sealTotpSecret = (raw: Buffer, rowId: string): Buffer => encryptBytes(raw, totpAad(rowId), key());
export const openTotpSecret = (sealed: Buffer, rowId: string): Buffer => decryptBytes(sealed, totpAad(rowId), key());

/** Secret mới: `secret` (base32) hiện làm setup key, `otpauthUrl` để FE vẽ QR. */
export function newTotpSetup(email: string): { raw: Buffer; secret: string; otpauthUrl: string } {
  const { raw, base32 } = generateTotpSecret();
  return { raw, secret: base32, otpauthUrl: totpUri({ issuer: ISSUER, label: email, secretBase32: base32 }) };
}

export const hashRecoveryCode = (code: string): string => sha256Hex(normalizeRecoveryCode(code));

/** Mã khôi phục chỉ trả một lần cho người dùng; DB giữ `hashes`. */
export function newRecoveryCodes(): { codes: string[]; hashes: string[] } {
  const codes = generateRecoveryCodes(RECOVERY_CODE_COUNT);
  return { codes, hashes: codes.map(hashRecoveryCode) };
}
