import type { OpenAPIRegistry, RouteConfig } from '@asteasolutions/zod-to-openapi';
import type { z } from 'zod';
import { problemResponse } from '../../../../shared/http/openapi.ts';
import { ReorderRuleBody, StockDetail, StockLevel, StockListQuery, StockPage, VariantParams } from './schemas.ts';

const json = (description: string, schema: z.ZodType) => ({ description, content: { 'application/json': { schema } } });
const body = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });

const common = {
  401: problemResponse('Chưa đăng nhập'),
  403: problemResponse('Chưa chọn công ty, công ty hoặc tài khoản bị khoá, hoặc thiếu quyền (`forbidden`)'),
};
const invalid = { 422: problemResponse('Dữ liệu không hợp lệ (`validation_failed`, `errors` theo ô)') };
const missing = (what: string) => ({ 404: problemResponse(`Không tìm thấy ${what} (kể cả của công ty khác)`) });
const conflict = (detail: string) => ({ 409: problemResponse(detail) });

/** Đường dẫn Swagger của module `inventory`, tương đối với /api/v1/inventory (Documents/21 mục 15.2). */
export function registerInventoryOpenApi(registry: OpenAPIRegistry): void {
  const path = (route: RouteConfig) => registry.registerPath({ ...route, responses: { ...common, ...route.responses } });

  path({
    method: 'get',
    path: '/stock',
    summary: 'Danh sách tồn theo biến thể (quyền `inventory.stock.view`; giá vốn chỉ với `inventory.cost.view`)',
    request: { query: StockListQuery },
    responses: { 200: json('Một trang tồn kèm tổng hợp toàn công ty', StockPage), ...invalid },
  });
  path({
    method: 'get',
    path: '/stock/:variantId',
    summary: 'Tồn một biến thể và 100 dòng thẻ kho mới nhất',
    request: { params: VariantParams },
    responses: { 200: json('Tồn và thẻ kho', StockDetail), ...missing('biến thể') },
  });
  path({
    method: 'put',
    path: '/stock/:variantId/reorder-rule',
    summary: 'Đặt hoặc bỏ ngưỡng tồn (quyền `inventory.reorder.manage`)',
    request: { params: VariantParams, body: body(ReorderRuleBody) },
    responses: {
      200: json('Tồn sau khi đặt ngưỡng', StockLevel),
      ...missing('biến thể'),
      ...conflict('`version_conflict`, kèm `current` là `StockLevel` mới nhất'),
      ...invalid,
    },
  });
}
