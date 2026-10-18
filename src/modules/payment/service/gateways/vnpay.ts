// VNPay "Thanh toán PAY" (https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html, đọc 18/10/2026): không gọi mạng,
// dựng URL `vpcpay.html` đã ký. Chưa có khoá `devreg` nên chưa thử trên sandbox (plan #23 AC-21 CHẶN).
import type { PaymentGateway } from './common.ts';
import { hmacHex, orderInfo, vnTimestamp } from './common.ts';

const PAY_URL = 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html';

/** `urlencode` của PHP (mã mẫu VNPay): dấu cách thành `+`, mã hoá cả `!'()*~`. */
const phpUrlencode = (s: string) =>
  encodeURIComponent(s)
    .replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');

/** `req.ip` của Express có thể là IPv6 (`::1`, `::ffff:a.b.c.d`); VNPay mẫu dùng IPv4. */
const ipv4 = (ip: string) => (ip === '::1' ? '127.0.0.1' : ip.replace(/^::ffff:/, ''));

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
    const query = Object.keys(params)
      .sort()
      .map((k) => `${phpUrlencode(k)}=${phpUrlencode(params[k]!)}`)
      .join('&');
    const payUrl = `${PAY_URL}?${query}&vnp_SecureHash=${hmacHex('sha512', credentials.hashSecret!, query)}`;
    return { payUrl, qrContent: payUrl, gatewayOrderRef: input.paymentCode };
  },
};
