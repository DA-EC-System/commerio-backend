import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { problemResponse } from '../../../../shared/http/openapi.ts';
import {
  CancelReasons,
  CancelRejectReasons,
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
      'Cần `sales.order.view`. Mới trước. `stage` suy từ kiện chỉ xét 1.000 đơn chưa dừng mới nhất; các bộ lọc khác (kể cả `flag=due_soon`, `flag=overdue`) không giới hạn.',
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
      'Cần `sales.order.cancel`. Gửi huỷ mọi món chưa huỷ lên sàn với lý do trong danh sách của sàn. Đơn giữ trạng thái, mang cờ `cancelling` tới khi lần kéo sau thấy sàn báo huỷ mọi món (còn kiện đã đóng gói thì tới khi kho mở hết); ghi lý do đã chọn vào `cancelReason` của đơn. Người huỷ (`seller`) nằm ở dòng khi sàn báo huỷ (`cancelInitiators`). Đơn đang có cờ `cancelling`: 409 `invalid_transition`.',
    security: bearer,
    request: { params: OrderParams, body: json(PlatformCancelBody) },
    responses: { 200: { description: 'Đơn sau khi gửi huỷ', ...json(PlatformCancelResult) }, ...onMarketplace },
  });
  registry.registerPath({
    method: 'post',
    path: '/orders/:id/cancel-request',
    summary: 'Trả lời khách xin huỷ (§19.3)',
    description:
      'Cần `sales.order.cancel`. Chỉ khi đơn có cờ `cancel_requested`. `accept`: khách xin huỷ mọi món chưa huỷ (hay sàn không ghi món nào) thì đơn sang cờ `cancelling` chờ sàn xác nhận, ghi lý do khách ghi trên món chưa huỷ vào `cancelReason` (không có thì "Khách xin huỷ"); khách chỉ xin huỷ một phần món (sàn huỷ theo món) thì là huỷ dòng: chỉ bỏ cờ `cancel_requested`, không `cancelling`, không `cancelReason`; `reject`: bỏ cờ. Sàn có danh sách lý do (`cancel-reject-reasons` không rỗng) thì bắt buộc `rejectReasonId` khi `reject` (thiếu: 422 `validation_failed` tại `errors.rejectReasonId`); sàn không có danh sách thì bỏ qua trường này.',
    security: bearer,
    request: { params: OrderParams, body: json(CancelRequestBody) },
    responses: { 200: { description: 'Đơn', ...json(Order) }, ...onMarketplace },
  });
  registry.registerPath({
    method: 'get',
    path: '/orders/:id/cancel-reject-reasons',
    summary: 'Lý do từ chối yêu cầu huỷ của sàn (§19.3)',
    description:
      'Cần `sales.order.cancel`. Chỉ khi đơn có cờ `cancel_requested`. Hỏi sàn lý do được dùng cho `rejectReasonId`; sàn không có danh sách này trả `{ items: [] }`; sàn không cho từ chối thì 409 `marketplace_rejected` kèm câu của sàn.',
    security: bearer,
    request: { params: OrderParams },
    responses: { 200: { description: 'Lý do', ...json(CancelRejectReasons) }, ...onMarketplace },
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
