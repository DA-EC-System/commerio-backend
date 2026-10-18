// MoMo ví, thanh toán một lần (https://developers.momo.vn/v3/docs/payment/api/wallet/onetime, đọc 18/10/2026).
// Đã gọi sandbox thật với khoá mẫu (ground-truth S1–S5).
import type { PaymentGateway } from './common.ts';
import { gatewayUnavailable, hmacHex, orderInfo, postJson } from './common.ts';

const CREATE_URL = 'https://test-payment.momo.vn/v2/gateway/api/create';

export const MomoGateway: PaymentGateway = {
  async createPayment(input, credentials, signal) {
    const body = {
      partnerCode: credentials.partnerCode!,
      requestId: input.paymentCode,
      orderId: input.paymentCode,
      amount: Number(input.amount.toFixed(0)),
      orderInfo: orderInfo(input.orderCode),
      redirectUrl: input.returnUrl,
      ipnUrl: `${input.ipnBaseUrl}/momo`,
      requestType: 'captureWallet',
      extraData: '',
      lang: 'vi',
      // Phút (theo ví dụ của tài liệu); hệ thống vẫn theo `expiresAt` của mình (T9).
      orderExpireTime: 15,
    };
    // Chuỗi ký: các khoá theo a→z (tài liệu MoMo).
    const raw =
      `accessKey=${credentials.accessKey}&amount=${body.amount}&extraData=${body.extraData}&ipnUrl=${body.ipnUrl}` +
      `&orderId=${body.orderId}&orderInfo=${body.orderInfo}&partnerCode=${body.partnerCode}` +
      `&redirectUrl=${body.redirectUrl}&requestId=${body.requestId}&requestType=${body.requestType}`;
    const res = await postJson(
      'MoMo',
      CREATE_URL,
      { contentType: 'application/json', body: JSON.stringify({ ...body, signature: hmacHex('sha256', credentials.secretKey!, raw) }) },
      signal,
    );
    if (res.resultCode !== 0 || typeof res.payUrl !== 'string') {
      // Không chép `message` của MoMo: câu báo sai chữ ký lặp lại chuỗi ký (S5).
      throw gatewayUnavailable(`MoMo từ chối tạo đơn (resultCode ${String(res.resultCode)})`);
    }
    return {
      payUrl: res.payUrl,
      qrContent: typeof res.qrCodeUrl === 'string' ? res.qrCodeUrl : res.payUrl,
      gatewayOrderRef: body.orderId,
    };
  },
};
