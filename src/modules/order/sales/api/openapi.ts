import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { problemResponse } from '../../../../shared/http/openapi.ts';
import { Order, OrderListQuery, OrderParams, OrderSummaryPage } from './schemas.ts';

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
      'Cần `sales.order.view`. Mới trước. `stage` (giai đoạn hiển thị) và `flag` (kể cả cờ suy ra: chưa ghép SKU, sắp trễ hạn, có yêu cầu trả) lọc sau khi suy ra từ kiện.',
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
}
