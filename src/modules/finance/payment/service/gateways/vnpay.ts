// VNPay "Thanh toán PAY" (https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html, đọc 18/10/2026): không gọi mạng,
// dựng URL `vpcpay.html` đã ký. IPN là GET, khai URL với VNPay theo merchant (không gửi theo request); querydr theo
// https://sandbox.vnpayment.vn/apis/docs/truy-van-hoan-tien/querydr&refund.html. Chưa có khoá `devreg` nên chưa thử trên
// sandbox (plan #23 AC-21, #27 AC-7, AC-19 CHẶN).
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import type { CallbackOutcome, GatewayResult, PaymentGateway } from './common.ts';
import { asRecord, fromVnTime, hmacHex, orderInfo, postJson, sameSecret, txnKey, vnTimestamp, withoutSignature } from './common.ts';

const PAY_URL = 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html';
const QUERY_URL = 'https://sandbox.vnpayment.vn/merchant_webapi/api/transaction';

/** `urlencode` của PHP (mã mẫu VNPay): dấu cách thành `+`, mã hoá cả `!'()*~`. Dùng cho cả ký URL và kiểm IPN. */
export const phpUrlencode = (s: string) =>
  encodeURIComponent(s)
    .replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');

/** `req.ip` của Express có thể là IPv6 (`::1`, `::ffff:a.b.c.d`); VNPay mẫu dùng IPv4. */
const ipv4 = (ip: string) => (ip === '::1' ? '127.0.0.1' : ip.replace(/^::ffff:/, ''));

/** Chuỗi ký theo mẫu PHP: tham số `vnp_*` sắp tăng dần, khoá và giá trị urlencode, nối `&`. */
const signData = (params: Record<string, string>) =>
  Object.keys(params)
    .sort()
    .map((k) => `${phpUrlencode(k)}=${phpUrlencode(params[k]!)}`)
    .join('&');

const RSP: Record<CallbackOutcome, [string, string]> = {
  recorded: ['00', 'Confirm Success'],
  unmatched: ['00', 'Confirm Success'],
  failed: ['00', 'Confirm Success'],
  duplicate: ['02', 'Order already confirmed'],
  not_found: ['01', 'Order not found'],
  bad_signature: ['97', 'Invalid signature'],
  error: ['99', 'Unknown error'],
};

/** Kết quả từ bộ tham số VNPay (IPN hoặc querydr) đã kiểm chữ ký. */
function resultOf(p: Record<string, unknown>, raw: Record<string, unknown>): GatewayResult {
  const paymentCode = String(p.vnp_TxnRef ?? '');
  const key = txnKey(p.vnp_TransactionNo, paymentCode, p.vnp_ResponseCode ?? p.vnp_TransactionStatus);
  return {
    paymentCode,
    eventKey: key,
    gatewayTxnId: key,
    amount: new Decimal(String(p.vnp_Amount ?? 0)).div(100),
    succeeded: p.vnp_TransactionStatus === '00' && (p.vnp_ResponseCode === undefined || p.vnp_ResponseCode === '00'),
    occurredAt: fromVnTime(p.vnp_PayDate) ?? new Date(),
    rawPayload: raw,
  };
}

export const VnpayGateway: PaymentGateway = {
  async createPayment(input, credentials) {
    const params: Record<string, string> = {
      vnp_Version: '2.1.0',
      vnp_Command: 'pay',
      vnp_TmnCode: credentials.tmnCode!,
      vnp_Amount: input.amount.times(100).toFixed(0),
      vnp_CurrCode: 'VND',
      vnp_TxnRef: input.paymentCode,
      vnp_OrderInfo: orderInfo(input.orderCode),
      vnp_OrderType: 'other',
      vnp_Locale: 'vn',
      vnp_ReturnUrl: input.returnUrl,
      vnp_IpAddr: ipv4(input.clientIp),
      vnp_CreateDate: vnTimestamp(input.createdAt),
      vnp_ExpireDate: vnTimestamp(input.expiresAt),
    };
    const query = signData(params);
    const payUrl = `${PAY_URL}?${query}&vnp_SecureHash=${hmacHex('sha512', credentials.hashSecret!, query)}`;
    return { payUrl, qrContent: payUrl, gatewayOrderRef: input.paymentCode };
  },

  codeOf({ query }) {
    return typeof query.vnp_TxnRef === 'string' && query.vnp_TxnRef ? query.vnp_TxnRef : null;
  },

  readCallback({ query }, credentials) {
    const params = Object.fromEntries(
      Object.entries(query).filter(
        (e): e is [string, string] =>
          e[0].startsWith('vnp_') && e[0] !== 'vnp_SecureHash' && e[0] !== 'vnp_SecureHashType' && typeof e[1] === 'string',
      ),
    );
    const expected = hmacHex('sha512', credentials.hashSecret!, signData(params));
    if (!sameSecret(query.vnp_SecureHash, expected, true)) return 'bad_signature';
    return resultOf(params, withoutSignature(query, 'vnp_SecureHash', 'vnp_SecureHashType'));
  },

  respond(outcome) {
    const [RspCode, Message] = RSP[outcome];
    return { status: 200, body: { RspCode, Message } };
  },

  async queryPayment(target, credentials, signal) {
    const createDate = vnTimestamp(new Date());
    const req = {
      vnp_RequestId: randomUUID().replaceAll('-', '').slice(0, 32),
      vnp_Version: '2.1.0',
      vnp_Command: 'querydr',
      vnp_TmnCode: credentials.tmnCode!,
      vnp_TxnRef: target.paymentCode,
      vnp_OrderInfo: `Tra cuu ${target.paymentCode}`,
      vnp_TransactionDate: vnTimestamp(target.createdAt),
      vnp_CreateDate: createDate,
      vnp_IpAddr: '127.0.0.1',
    };
    const data = [
      req.vnp_RequestId,
      req.vnp_Version,
      req.vnp_Command,
      req.vnp_TmnCode,
      req.vnp_TxnRef,
      req.vnp_TransactionDate,
      req.vnp_CreateDate,
      req.vnp_IpAddr,
      req.vnp_OrderInfo,
    ].join('|');
    const res = await postJson(
      'VNPay',
      QUERY_URL,
      { contentType: 'application/json', body: JSON.stringify({ ...req, vnp_SecureHash: hmacHex('sha512', credentials.hashSecret!, data) }) },
      signal,
    );
    // Chưa kiểm checksum của response: chưa có khoá sandbox để đo đúng chuỗi (tài liệu D2 có lỗi đánh máy).
    if (res.vnp_ResponseCode !== '00') return 'not_found';
    if (res.vnp_TransactionStatus === '01') return 'pending';
    const r = resultOf(asRecord(res), withoutSignature(asRecord(res), 'vnp_SecureHash'));
    return r.succeeded ? r : 'not_found';
  },
};
