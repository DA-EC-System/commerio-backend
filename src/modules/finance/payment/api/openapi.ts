import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { problemResponse } from '../../../../shared/http/openapi.ts';
import {
  CreateLinkBody,
  GatewayConfig,
  GatewayConfigRequest,
  GatewayParams,
  GatewaySummary,
  OrderParams,
  OrderPayment,
  PaymentLink,
  PaymentTransactionDetail,
  TransactionListQuery,
  TransactionPage,
  TransactionParams,
  UnpaidOrderListQuery,
  UnpaidOrderPage,
} from './schemas.ts';
import { registerWebhookOpenApi } from './openapi-webhooks.ts';

const json = <T>(schema: T) => ({ content: { 'application/json': { schema } } });
const bearer = [{ bearerAuth: [] }];
const auth = {
  401: problemResponse('`unauthorized`'),
  403: problemResponse('`company_not_selected`, `company_locked`, `account_locked`, `forbidden`'),
};

/** Đường dẫn Swagger của module `payment`, viết tương đối với /api/v1/payment. */
export function registerPaymentOpenApi(registry: OpenAPIRegistry): void {
  registerWebhookOpenApi(registry);
  registry.registerPath({
    method: 'get',
    path: '/gateways',
    summary: 'Cổng thanh toán của công ty (UC-PF-11)',
    description:
      'Cần `payment.gateway.manage` (trả `GatewayConfig`, khoá đã che) hoặc `payment.link.create` (chỉ `{ gateway, configured }`). Luôn 4 phần tử theo thứ tự vnpay, momo, zalopay, vietqr.',
    security: bearer,
    responses: {
      200: { description: 'Cổng thanh toán', ...json(z.union([z.array(GatewayConfig), z.array(GatewaySummary)])) },
      ...auth,
    },
  });
  registry.registerPath({
    method: 'put',
    path: '/gateways/:gateway',
    summary: 'Lưu khoá sandbox của một cổng (UC-PF-11)',
    description:
      'Cần `payment.gateway.manage`. Gửi đủ các ô của cổng mỗi lần lưu; khoá mã hoá AES-256-GCM, không bao giờ trả lại (chỉ `last4`). Không gọi thử cổng khi lưu.',
    security: bearer,
    request: { params: GatewayParams, body: json(GatewayConfigRequest) },
    responses: {
      200: { description: 'Cấu hình sau khi lưu (đã che)', ...json(GatewayConfig) },
      ...auth,
      404: problemResponse('`not_found`: cổng không thuộc 4 cổng'),
      409: problemResponse('`version_conflict` kèm `current` (đã che)'),
      422: problemResponse('`validation_failed`: `errors["credentials.<ô>"]`, `errors.version`'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/orders/:orderId/links',
    summary: 'Tạo mã QR/link thanh toán cho đơn (UC-PF-01)',
    description:
      'Cần `payment.link.create`. Đơn tay/hộp thư trả trước, chưa thu. Mỗi đơn tối đa một mã còn hạn (15 phút): đơn đã có mã còn hạn thì trả 200 mã đó, kể cả gửi cổng khác, không gọi cổng. Mã đã quá hạn thì chuyển `expired` và tạo mã mới.',
    security: bearer,
    request: { params: OrderParams, body: json(CreateLinkBody) },
    responses: {
      201: { description: 'Mã mới', ...json(PaymentLink) },
      200: { description: 'Mã đang còn hạn của đơn', ...json(PaymentLink) },
      ...auth,
      404: problemResponse('`not_found`: đơn không có hoặc của công ty khác'),
      409: problemResponse('`payment_not_allowed`: đơn COD, đơn sàn, đã thanh toán, đã huỷ, tổng có phần lẻ đồng, hoặc ngoài hạn mức MoMo (1.000–50.000.000 đ); `detail` nêu lý do'),
      422: problemResponse('`gateway_not_configured` kèm `errors.gateway`; `validation_failed` khi `gateway` sai'),
      502: problemResponse('`gateway_unavailable`: cổng lỗi, quá 10 giây, hoặc từ chối khoá; không ghi gì'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/orders/:orderId',
    summary: 'Trạng thái thanh toán của đơn',
    description:
      'Cần `sales.order.view`. Đơn chưa xác nhận (chưa có dòng trạng thái tiền) trả trạng thái suy từ đơn. `activeLink` là mã còn hạn; trong `links` (mới nhất trước, tối đa 20) mã quá hạn hiện `expired`.',
    security: bearer,
    request: { params: OrderParams },
    responses: {
      200: { description: 'Trạng thái thanh toán', ...json(OrderPayment) },
      ...auth,
      404: problemResponse('`not_found`: đơn không có, của công ty khác, hoặc đơn sàn'),
    },
  });  registry.registerPath({
    method: 'get',
    path: '/orders',
    summary: 'Đơn chưa thu (hộp gán khoản thu chưa khớp, R1)',
    description: 'Cần `finance.voucher.create`. Đơn đã xác nhận, trả trước, `unpaid`; `search` theo mã đơn, tên khách.',
    security: bearer,
    request: { query: UnpaidOrderListQuery },
    responses: { 200: { description: 'Trang đơn chưa thu', ...json(UnpaidOrderPage) }, ...auth, 422: problemResponse('`validation_failed`') },
  });
  registry.registerPath({
    method: 'get',
    path: '/transactions',
    summary: 'Giao dịch cổng của công ty (UC-PF-03, tab Giao dịch cổng)',
    description:
      'Cần `payment.transaction.view`. Mới nhất trước. `search` khớp mã thanh toán, mã giao dịch của cổng, mã đơn. `from`/`to` theo `occurredAt`, trọn ngày giờ VN (C6).',
    security: bearer,
    request: { query: TransactionListQuery },
    responses: {
      200: { description: 'Trang giao dịch', ...json(TransactionPage) },
      ...auth,
      422: problemResponse('`validation_failed`: `errors.status`, `errors.gateway`, `errors.from`, …'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/transactions/:id',
    summary: 'Một giao dịch cổng, kèm payload của cổng (đã bỏ chữ ký)',
    security: bearer,
    request: { params: TransactionParams },
    responses: {
      200: { description: 'Giao dịch', ...json(PaymentTransactionDetail) },
      ...auth,
      404: problemResponse('`not_found`: không có hoặc của công ty khác'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/dev/simulate/:paymentCode',
    summary: 'Mô phỏng khách trả đủ tiền (chỉ môi trường không phải production)',
    description:
      'Cần `payment.link.create`. Đi đúng đường xử lý webhook (phiếu thu, đơn `paid`), bỏ bước chữ ký. Dùng cho demo, E2E. Không có ở production.',
    security: bearer,
    request: { params: z.object({ paymentCode: z.string() }) },
    responses: {
      200: { description: 'Kết quả', ...json(z.object({ outcome: z.enum(['recorded', 'duplicate', 'unmatched', 'failed']) })) },
      ...auth,
      404: problemResponse('`not_found`: mã không có hoặc của công ty khác'),
    },
  });
}
