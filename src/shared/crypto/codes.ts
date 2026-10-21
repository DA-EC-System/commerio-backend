// Mã ngẫu nhiên và so sánh an toàn thời gian: OTP email (#7 [C]), mã khôi phục 2FA (#7 [D]).
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

/** Chuỗi `length` chữ số ngẫu nhiên (CSPRNG), giữ số 0 đầu. */
export function randomDigits(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += randomInt(10).toString();
  return out;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** So hai chuỗi hex mà thời gian không phụ thuộc vị trí khác nhau; độ dài khác thì `false`. */
export function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length || left.length * 2 !== a.length || right.length * 2 !== b.length) return false;
  return timingSafeEqual(left, right);
}
