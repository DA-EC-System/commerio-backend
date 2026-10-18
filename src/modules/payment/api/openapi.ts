import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { problemResponse } from '../../../shared/http/openapi.ts';
import { GatewayConfig, GatewayConfigRequest, GatewayParams, GatewaySummary } from './schemas.ts';

const json = <T>(schema: T) => ({ content: { 'application/json': { schema } } });
const bearer = [{ bearerAuth: [] }];
const auth = {
  401: problemResponse('`unauthorized`'),
  403: problemResponse('`company_not_selected`, `company_locked`, `account_locked`, `forbidden`'),
};

/** Đường dẫn Swagger của module `payment`, viết tương đối với /api/v1/payment. */
export function registerPaymentOpenApi(registry: OpenAPIRegistry): void {
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
}
