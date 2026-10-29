// ZaloPay: tạo đơn (https://docs.zalopay.vn/docs/specs/order-create/), callback (…/specs/callback-api/: `{data, mac, type}`,
// mac = HMAC-SHA256(key2, data)), tra cứu (…/specs/order-query/), đọc 18/10/2026. Đã gọi sandbox thật với khoá mẫu: tạo
// đơn (#23 ground-truth S6–S10), tra cứu (#27 ground-truth S3, S4).
import { Decimal } from 'decimal.js';
import type { CallbackOutcome, GatewayResult, PaymentGateway } from './common.ts';
import { asRecord, gatewayUnavailable, hmacHex, orderInfo, postJson, sameSecret, vnTimestamp } from './common.ts';

const CREATE_URL = 'https://sb-openapi.zalopay.vn/v2/create';
const QUERY_URL = 'https://sb-openapi.zalopay.vn/v2/query';

/** Mã thanh toán là phần sau `yymmdd_` của `app_trans_id` (T3). */
const codeOfTransId = (appTransId: unknown) => {
  const code = typeof appTransId === 'string' ? appTransId.split('_')[1] : undefined;
  return code || null;
};

function parseData(data: unknown): Record<string, unknown> {
  try {
    return typeof data === 'string' ? asRecord(JSON.parse(data)) : {};
  } catch {
    return {};
  }
}

function resultOf(d: Record<string, unknown>, appTransId: unknown): GatewayResult {
  if (d.zp_trans_id === undefined || d.zp_trans_id === null) throw new Error('ZaloPay thiếu zp_trans_id');
  const key = String(d.zp_trans_id);
  return {
    paymentCode: codeOfTransId(appTransId),
    eventKey: key,
    gatewayTxnId: key,
    amount: new Decimal(String(d.amount ?? 0)),
    // ZaloPay chỉ gọi callback khi thanh toán thành công (tài liệu callback).
    succeeded: true,
    occurredAt: typeof d.server_time === 'number' ? new Date(d.server_time) : new Date(),
    rawPayload: d,
  };
}

const RETURN: Record<CallbackOutcome, number> = {
  recorded: 1,
  unmatched: 1,
  failed: 1,
  duplicate: 2,
  bad_signature: -1,
  not_found: -1,
  error: 0,
};

export const ZalopayGateway: PaymentGateway = {
  async createPayment(input, credentials, signal) {
    const order = {
      app_id: credentials.appId!,
      // `yymmdd_` theo ngày giờ Việt Nam, ZaloPay từ chối ngày lệch (T3).
      app_trans_id: `${vnTimestamp(input.createdAt).slice(2, 8)}_${input.paymentCode}`,
      app_user: 'commerio',
      amount: input.amount.toFixed(0),
      app_time: String(input.createdAt.getTime()),
      item: '[]',
      embed_data: JSON.stringify({ redirecturl: input.returnUrl }),
      description: `Commerio - ${orderInfo(input.orderCode)}`,
      bank_code: '',
      callback_url: `${input.ipnBaseUrl}/zalopay`,
      // Tối thiểu 300 giây (S10); 15 phút như T9.
      expire_duration_seconds: String(Math.round((input.expiresAt.getTime() - input.createdAt.getTime()) / 1000)),
    };
    const mac = hmacHex(
      'sha256',
      credentials.key1!,
      [order.app_id, order.app_trans_id, order.app_user, order.amount, order.app_time, order.embed_data, order.item].join('|'),
    );
    const res = await postJson(
      'ZaloPay',
      CREATE_URL,
      { contentType: 'application/x-www-form-urlencoded', body: new URLSearchParams({ ...order, mac }).toString() },
      signal,
    );
    if (res.return_code !== 1 || typeof res.order_url !== 'string') {
      throw gatewayUnavailable(`ZaloPay từ chối tạo đơn (return_code ${String(res.return_code)}, ${String(res.sub_return_code)})`);
    }
    return {
      payUrl: res.order_url,
      qrContent: typeof res.qr_code === 'string' ? res.qr_code : res.order_url,
      gatewayOrderRef: order.app_trans_id,
    };
  },

  codeOf({ body }) {
    return codeOfTransId(parseData(asRecord(body).data).app_trans_id);
  },

  readCallback({ body }, credentials) {
    const b = asRecord(body);
    // mac tính trên chuỗi `data` gốc, không parse rồi dựng lại.
    if (typeof b.data !== 'string' || !sameSecret(b.mac, hmacHex('sha256', credentials.key2!, b.data))) return 'bad_signature';
    const d = parseData(b.data);
    return resultOf(d, d.app_trans_id);
  },

  respond(outcome) {
    const code = RETURN[outcome];
    return { status: 200, body: { return_code: code, return_message: code === 1 ? 'success' : code === 2 ? 'duplicate' : 'error' } };
  },

  async queryPayment(target, credentials, signal) {
    const appTransId = target.gatewayOrderRef;
    if (!appTransId) return 'not_found';
    const mac = hmacHex('sha256', credentials.key1!, `${credentials.appId}|${appTransId}|${credentials.key1}`);
    const res = await postJson(
      'ZaloPay',
      QUERY_URL,
      {
        contentType: 'application/x-www-form-urlencoded',
        body: new URLSearchParams({ app_id: credentials.appId!, app_trans_id: appTransId, mac }).toString(),
      },
      signal,
    );
    // 1 đã trả; 3 chưa thực hiện (S3); 2 không có đơn hoặc lỗi (S4).
    if (res.return_code === 1) return resultOf(res, appTransId);
    return res.return_code === 3 ? 'pending' : 'not_found';
  },
};
