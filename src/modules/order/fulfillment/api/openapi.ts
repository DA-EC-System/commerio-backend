import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { problemResponse } from '../../../../shared/http/openapi.ts';
import { HandOverBody, HandOverResult, Package, PackageListQuery, PackagePage, PackageParams } from './schemas.ts';

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
    method: 'post',
    path: '/packages/hand-over',
    summary: 'Kho quét bàn giao kiện theo lô (§19.2)',
    description:
      'Cần `fulfillment.order.process`. 1–50 kiện, mỗi kiện một lần; mỗi kiện một giao dịch, kiện lỗi vào `failed` với `code`: `not_found`, `version_conflict`, `already_handed_over`, `invalid_transition`, `internal_error`. Kiện bàn giao sang `in_transit`, trừ tồn một lần, có phiếu `XK`.',
    security: bearer,
    request: { body: { content: { 'application/json': { schema: HandOverBody } } } },
    responses: { 200: { description: 'Kết quả từng kiện', ...json(HandOverResult) }, ...auth, 422: problemResponse('`validation_failed`: body rỗng, quá 50, id trùng hoặc sai dạng') },
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
