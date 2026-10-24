// Mã thanh toán (Documents/21 T3): `CM` + 10 ký tự ngẫu nhiên, bỏ ký tự dễ nhầm `0 O 1 I L`. Unique toàn hệ thống (D14).
// Dùng làm vnp_TxnRef, MoMo orderId, hậu tố ZaloPay app_trans_id, nội dung chuyển khoản VietQR.
import { randomInt } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newPaymentCode(): string {
  let code = 'CM';
  for (let i = 0; i < 10; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}
