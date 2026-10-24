// MoMo ví, thanh toán một lần (https://developers.momo.vn/v3/docs/payment/api/wallet/onetime, đọc 18/10/2026): tạo đơn,
// IPN (POST JSON, chữ ký HMAC-SHA256 13 trường, trả 204), tra cứu `/v2/gateway/api/query`. Đã gọi sandbox thật với khoá
// mẫu: tạo đơn (#23 ground-truth S1–S5), tra cứu (#27 ground-truth S1, S2: response tra cứu không có chữ ký).
import { Decimal } from 'decimal.js';
import type { GatewayResult, PaymentGateway } from './common.ts';
import { asRecord, gatewayUnavailable, hmacHex, orderInfo, postJson, sameSecret, txnKey, withoutSignature } from './common.ts';

const CREATE_URL = 'https://test-payment.momo.vn/v2/gateway/api/create';
const QUERY_URL = 'https://test-payment.momo.vn/v2/gateway/api/query';
/** `resultCode` của giao dịch còn chờ người dùng (#27 ground-truth S1). */
const PENDING = 1000;

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));

function resultOf(b: Record<string, unknown>): GatewayResult {
  const paymentCode = str(b.orderId);
  const key = txnKey(b.transId, paymentCode, b.resultCode);
  return {
    paymentCode,
    eventKey: key,
    gatewayTxnId: key,
    amount: new Decimal(str(b.amount) || 0),
    succeeded: b.resultCode === 0,
    occurredAt: typeof b.responseTime === 'number' ? new Date(b.responseTime) : new Date(),
    rawPayload: withoutSignature(b, 'signature'),
  };
}

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

  codeOf({ body }) {
    const orderId = asRecord(body).orderId;
    return typeof orderId === 'string' && orderId ? orderId : null;
  },

  readCallback({ body }, credentials) {
    const b = asRecord(body);
    // Chuỗi ký IPN: 13 trường theo a→z (tài liệu MoMo, mục IPN).
    const raw =
      `accessKey=${credentials.accessKey}&amount=${str(b.amount)}&extraData=${str(b.extraData)}&message=${str(b.message)}` +
      `&orderId=${str(b.orderId)}&orderInfo=${str(b.orderInfo)}&orderType=${str(b.orderType)}` +
      `&partnerCode=${str(b.partnerCode)}&payType=${str(b.payType)}&requestId=${str(b.requestId)}` +
      `&responseTime=${str(b.responseTime)}&resultCode=${str(b.resultCode)}&transId=${str(b.transId)}`;
    if (!sameSecret(b.signature, hmacHex('sha256', credentials.secretKey!, raw))) return 'bad_signature';
    return resultOf(b);
  },

  respond(outcome) {
    if (outcome === 'error') return { status: 500, body: undefined };
    if (outcome === 'bad_signature' || outcome === 'not_found') return { status: 400, body: undefined };
    return { status: 204, body: undefined };
  },

  async queryPayment(target, credentials, signal) {
    const requestId = `${target.paymentCode}-${Date.now()}`;
    const raw =
      `accessKey=${credentials.accessKey}&orderId=${target.paymentCode}` +
      `&partnerCode=${credentials.partnerCode}&requestId=${requestId}`;
    const res = await postJson(
      'MoMo',
      QUERY_URL,
      {
        contentType: 'application/json',
        body: JSON.stringify({
          partnerCode: credentials.partnerCode,
          requestId,
          orderId: target.paymentCode,
          lang: 'vi',
          signature: hmacHex('sha256', credentials.secretKey!, raw),
        }),
      },
      signal,
    );
    if (res.resultCode === 0) return resultOf(res);
    return res.resultCode === PENDING ? 'pending' : 'not_found';
  },
};
