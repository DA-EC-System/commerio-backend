import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

// Swagger của webhook 4 cổng (Documents/21 §12.4, T6): không token, phản hồi theo định dạng của cổng.

const json = <T>(schema: T) => ({ content: { 'application/json': { schema } } });
const VnpayReply = z.object({ RspCode: z.enum(['00', '01', '02', '97', '99']), Message: z.string() });
const ZalopayReply = z.object({ return_code: z.union([z.literal(1), z.literal(2), z.literal(-1), z.literal(0)]), return_message: z.string() });
const SepayReply = z.object({ success: z.boolean() });

export function registerWebhookOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/webhooks/vnpay',
    summary: 'IPN của VNPay (UC-PF-03)',
    description:
      'Không token. Kiểm `vnp_SecureHash` (HMAC-SHA512, `hashSecret` của công ty sở hữu mã `vnp_TxnRef`). Luôn HTTP 200: `00` đã ghi (kể cả lệch tiền đã vào khoản thu chưa khớp, giao dịch thất bại), `01` không thấy mã, `02` đã xử lý, `97` sai chữ ký, `99` lỗi khác. URL này khai với VNPay theo merchant.',
    request: { query: z.object({ vnp_TxnRef: z.string(), vnp_SecureHash: z.string() }).catchall(z.string()) },
    responses: { 200: { description: 'Phản hồi cho VNPay', ...json(VnpayReply) } },
  });
  registry.registerPath({
    method: 'post',
    path: '/webhooks/momo',
    summary: 'IPN của MoMo (UC-PF-03)',
    description: 'Không token. Kiểm `signature` (HMAC-SHA256 13 trường, `secretKey` của công ty sở hữu mã `orderId`).',
    request: { body: json(z.object({ orderId: z.string(), signature: z.string() }).catchall(z.unknown())) },
    responses: {
      204: { description: 'Đã ghi hoặc đã xử lý' },
      400: { description: 'Sai chữ ký hoặc không thấy mã' },
      500: { description: 'Lỗi, MoMo gửi lại' },
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/webhooks/zalopay',
    summary: 'Callback của ZaloPay (UC-PF-03)',
    description:
      'Không token. `mac` = HMAC-SHA256(`key2` của công ty, `data`). `return_code`: 1 đã ghi, 2 đã xử lý, -1 sai `mac` hoặc không thấy mã, 0 lỗi (ZaloPay gửi lại).',
    request: { body: json(z.object({ data: z.string(), mac: z.string(), type: z.number() })) },
    responses: { 200: { description: 'Phản hồi cho ZaloPay', ...json(ZalopayReply) } },
  });
  registry.registerPath({
    method: 'post',
    path: '/webhooks/sepay/:receiverKey',
    summary: 'Webhook SePay báo tiền vào tài khoản VietQR (UC-PF-03)',
    description:
      'Không token. `:receiverKey` xác định công ty (URL riêng mỗi công ty, T12); header `Authorization: Apikey <sepayApiKey>`. Mã thanh toán tìm ở `code` rồi `content`; không có thì vào khoản thu chưa khớp `no_payment_code`. Tiền ra (`transferType: out`) bỏ qua.',
    request: {
      params: z.object({ receiverKey: z.string() }),
      body: json(z.object({ id: z.number(), transferType: z.string(), transferAmount: z.number(), content: z.string() }).catchall(z.unknown())),
    },
    responses: {
      200: { description: 'Đã ghi, đã xử lý, hoặc bỏ qua tiền ra', ...json(SepayReply) },
      401: { description: 'Sai API key', ...json(SepayReply) },
      404: { description: '`receiverKey` không có', ...json(SepayReply) },
    },
  });
}
