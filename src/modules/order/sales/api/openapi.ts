import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { problemResponse } from '../../../../shared/http/openapi.ts';
import {
  CancelReasons,
  CancelRequestBody,
  InvoiceNumberBody,
  Order,
  OrderListQuery,
  OrderParams,
  OrderSummaryPage,
  PlatformCancelBody,
  PlatformCancelResult,
} from './schemas.ts';

const bearer = [{ bearerAuth: [] }];
const json = <T>(schema: T) => ({ content: { 'application/json': { schema } } });
const auth = {
  401: problemResponse('Thiếu, sai hoặc hết hạn token'),
  403: problemResponse('`forbidden`, `company_not_selected`, `module_disabled`'),
};

/** Đường dẫn Swagger của module `sales`, viết tương đối với /api/v1/sales. */
export function registerSalesOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/orders',
    summary: 'Danh sách đơn (§19.1)',
    description:
      'Cần `sales.order.view`. Mới trước. `stage` suy từ kiện và `flag=due_soon` chỉ xét 1.000 đơn chưa dừng mới nhất; các bộ lọc khác không giới hạn.',
    security: bearer,
    request: { query: OrderListQuery },
    responses: { 200: { description: 'Một trang đơn', ...json(OrderSummaryPage) }, ...auth, 422: problemResponse('`validation_failed`') },
  });
  registry.registerPath({
    method: 'get',
    path: '/orders/:id',
    summary: 'Chi tiết đơn (§19.1)',
    description: 'Cần `sales.order.view`. Kèm dòng, kiện, lịch sử trạng thái, lý do chưa hoàn tất.',
    security: bearer,
    request: { params: OrderParams },
    responses: { 200: { description: 'Đơn', ...json(Order) }, ...auth, 404: problemResponse('`not_found`: không có hoặc của công ty khác') },
  });
  const onMarketplace = {
    ...auth,
    404: problemResponse('`not_found`: không có hoặc của công ty khác'),
    409: problemResponse(
      '`invalid_transition` (đơn đang huỷ, không có yêu cầu huỷ), `already_handed_over`, `version_conflict` kèm `current`, `shop_not_connected`, `marketplace_rejected` kèm `platformCode`, `platformMessage`',
    ),
    422: problemResponse('`validation_failed`, `not_allowed_for_source` (đơn không phải đơn sàn), `marketplace_unsupported`'),
    503: problemResponse('`marketplace_unavailable`: sàn lỗi tạm, thử lại'),
  };
  registry.registerPath({
    method: 'get',
    path: '/orders/:id/cancel-reasons',
    summary: 'Lý do huỷ đơn sàn cho phép (§19.3)',
    description: 'Cần `sales.order.cancel`. Hỏi sàn đơn còn huỷ được không; sàn không cho thì 409 `marketplace_rejected` kèm câu của sàn.',
    security: bearer,
    request: { params: OrderParams },
    responses: { 200: { description: 'Lý do', ...json(CancelReasons) }, ...onMarketplace },
  });
  registry.registerPath({
    method: 'post',
    path: '/orders/:id/platform-cancel',
    summary: 'Người bán huỷ đơn sàn (§19.3)',
    description:
      'Cần `sales.order.cancel`. Gửi huỷ lên sàn với lý do trong danh sách của sàn. Đơn giữ trạng thái, mang cờ `cancelling` tới khi lần kéo sau thấy sàn báo huỷ.',
    security: bearer,
    request: { params: OrderParams, body: json(PlatformCancelBody) },
    responses: { 200: { description: 'Đơn sau khi gửi huỷ', ...json(PlatformCancelResult) }, ...onMarketplace },
  });
  registry.registerPath({
    method: 'post',
    path: '/orders/:id/cancel-request',
    summary: 'Trả lời khách xin huỷ (§19.3)',
    description: 'Cần `sales.order.cancel`. Chỉ khi đơn có cờ `cancel_requested`. `accept`: đơn sang cờ `cancelling` chờ sàn xác nhận; `reject`: bỏ cờ.',
    security: bearer,
    request: { params: OrderParams, body: json(CancelRequestBody) },
    responses: { 200: { description: 'Đơn', ...json(Order) }, ...onMarketplace },
  });
  registry.registerPath({
    method: 'put',
    path: '/orders/:id/invoice-number',
    summary: 'Nhập số hoá đơn của đơn (§19.3)',
    description: 'Cần `sales.order.create`. Chỉ lưu trong app, chưa gửi lên sàn.',
    security: bearer,
    request: { params: OrderParams, body: json(InvoiceNumberBody) },
    responses: {
      200: { description: 'Đơn', ...json(Order) },
      ...auth,
      404: problemResponse('`not_found`'),
      409: problemResponse('`version_conflict` kèm `current`'),
      422: problemResponse('`validation_failed`'),
    },
  });
}
