// VietQR: chuỗi EMVCo chuyển khoản tới tài khoản công ty, nội dung là mã thanh toán (QT-37). Không gọi mạng; tiền về
// được SePay báo qua webhook riêng mỗi công ty (D16): header `Authorization: Apikey <key>`, trả 200 `{"success": true}`
// (https://developer.sepay.vn/en/sepay-webhooks/tich-hop-webhook, …/xac-thuc, đọc 18/10/2026). Không có API tra cứu.
import { Decimal } from 'decimal.js';
import { buildVietQr } from '../../domain/vietqr.ts';
import type { PaymentGateway } from './common.ts';
import { asRecord, fromVnTime, sameSecret } from './common.ts';

/** Mã thanh toán trong nội dung chuyển khoản (§12.4; rộng hơn bảng sinh mã, không sao). */
const CODE_IN_CONTENT = /CM[A-HJ-NP-Z2-9]{10}/;

export const VietqrGateway: PaymentGateway = {
  async createPayment(input, credentials) {
    const qrContent = buildVietQr({
      bankBin: credentials.bankBin!,
      accountNo: credentials.accountNo!,
      amount: input.amount,
      content: input.paymentCode,
    });
    return { payUrl: null, qrContent, gatewayOrderRef: null };
  },

  // Webhook SePay biết công ty qua `receiverKey` của URL, không qua mã (D16).
  codeOf() {
    return null;
  },

  readCallback({ body, headers }, credentials) {
    const auth = typeof headers.authorization === 'string' ? headers.authorization : '';
    if (!auth.startsWith('Apikey ') || !sameSecret(auth.slice('Apikey '.length), credentials.sepayApiKey!)) return 'bad_signature';
    const b = asRecord(body);
    // `code` là mã SePay tách theo tiền tố công ty cấu hình; chỉ dùng khi đúng dạng mã thanh toán, không thì tìm trong nội dung.
    const fromCode = typeof b.code === 'string' ? CODE_IN_CONTENT.exec(b.code.toUpperCase())?.[0] : undefined;
    const code = fromCode ?? CODE_IN_CONTENT.exec(String(b.content ?? '').toUpperCase())?.[0] ?? null;
    if (b.id === undefined || b.id === null) throw new Error('SePay thiếu id giao dịch');
    const key = String(b.id);
    return {
      paymentCode: code,
      eventKey: key,
      gatewayTxnId: key,
      amount: new Decimal(String(b.transferAmount ?? 0)),
      succeeded: true,
      occurredAt: fromVnTime(b.transactionDate) ?? new Date(),
      rawPayload: b,
    };
  },

  respond(outcome) {
    if (outcome === 'bad_signature') return { status: 401, body: { success: false } };
    if (outcome === 'not_found') return { status: 404, body: { success: false } };
    if (outcome === 'error') return { status: 500, body: { success: false } };
    return { status: 200, body: { success: true } };
  },

  async queryPayment() {
    return 'pending';
  },
};
