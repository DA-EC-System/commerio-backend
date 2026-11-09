import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { problemResponse } from '../../../../shared/http/openapi.ts';
import { Package, PackageListQuery, PackagePage, PackageParams } from './schemas.ts';

const bearer = [{ bearerAuth: [] }];
const json = <T>(schema: T) => ({ content: { 'application/json': { schema } } });
const auth = {
  401: problemResponse('Thiếu, sai hoặc hết hạn token'),
  403: problemResponse('`forbidden`, `company_not_selected`, `module_disabled`'),
};

/** Đường dẫn Swagger của module `fulfillment`, viết tương đối với /api/v1/fulfillment. */
export function registerFulfillmentOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/packages',
    summary: 'Danh sách kiện theo tab (§19.2)',
    description: 'Cần `fulfillment.order.process`. Sắp `ship_by` tăng dần (null cuối) rồi mã kiện. `counts` theo `search`, `source`, `shopId`, không theo `tab`.',
    security: bearer,
    request: { query: PackageListQuery },
    responses: { 200: { description: 'Một trang kiện', ...json(PackagePage) }, ...auth, 422: problemResponse('`validation_failed`') },
  });
  registry.registerPath({
    method: 'get',
    path: '/packages/:id',
    summary: 'Chi tiết kiện (§19.2)',
    description: 'Cần `fulfillment.order.process`. Kèm lịch sử trạng thái.',
    security: bearer,
    request: { params: PackageParams },
    responses: { 200: { description: 'Kiện', ...json(Package) }, ...auth, 404: problemResponse('`not_found`: không có hoặc của công ty khác') },
  });
}
