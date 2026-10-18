// ZaloPay tạo đơn (https://docs.zalopay.vn/docs/specs/order-create/, đọc 18/10/2026). Đã gọi sandbox thật với khoá mẫu
// (ground-truth S6–S10).
import type { PaymentGateway } from './common.ts';
import { gatewayUnavailable, hmacHex, orderInfo, postJson, vnTimestamp } from './common.ts';

const CREATE_URL = 'https://sb-openapi.zalopay.vn/v2/create';

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
};
