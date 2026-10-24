// TOTP theo RFC 6238 (#7 [D]), tự viết bằng node:crypto (docs/17): HMAC-SHA1, 6 chữ số, bước 30 giây, cách tính
// mã của HOTP (RFC 4226). Secret 20 byte, hiện cho người dùng dạng base32 (RFC 4648, không đệm).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
const SECRET_BYTES = 20;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Nhận chữ thường, bỏ `=` đệm; ký tự ngoài bảng thì ném. */
export function base32Decode(text: string): Buffer {
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of text.toUpperCase().replace(/=+$/, '')) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Chuỗi base32 không hợp lệ');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): { raw: Buffer; base32: string } {
  const raw = randomBytes(SECRET_BYTES);
  return { raw, base32: base32Encode(raw) };
}

/** URI cho app Authenticator; FE vẽ QR từ chuỗi này. */
export function totpUri(input: { issuer: string; label: string; secretBase32: string }): string {
  const issuer = encodeURIComponent(input.issuer);
  return `otpauth://totp/${issuer}:${encodeURIComponent(input.label)}?secret=${input.secretBase32}&issuer=${issuer}`;
}

/** Mã của bước `step` (số bước 30 giây tính từ epoch). */
export function totpAt(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', secret).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return (binary % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, '0');
}

/**
 * Bước khớp với `code` trong khoảng ±`window` bước quanh `nowMs`, hoặc `null`. Bên gọi ghi bước này
 * (`totp_last_step`) để mỗi mã chỉ dùng được một lần.
 */
export function matchTotp(secret: Buffer, code: string, nowMs: number, window = 1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
  const given = Buffer.from(code);
  let matched: number | null = null;
  // Duyệt hết cửa sổ để thời gian không lộ bước nào khớp.
  for (let step = current - window; step <= current + window; step++) {
    if (timingSafeEqual(Buffer.from(totpAt(secret, step)), given) && matched === null) matched = step;
  }
  return matched;
}
