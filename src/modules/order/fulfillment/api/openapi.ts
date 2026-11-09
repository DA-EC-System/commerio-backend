import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { problemResponse } from '../../../../shared/http/openapi.ts';
import {
  HandOverBody,
  HandOverResult,
  Package,
  PackageListQuery,
  PackagePage,
  PackageParams,
  ReceiveReturnBody,
  UndoHandoverBody,
} from './schemas.ts';

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
    method: 'post',
    path: '/packages/:id/undo-handover',
    summary: 'Huỷ bàn giao nhầm (§19.2)',
    description:
      'Cần `fulfillment.handover.revert` (CEO). Chỉ kiện kho quét mà sàn chưa xác nhận lấy. Đảo đủ cả lượt (phiếu `DX`), kiện về `awaiting_pickup`, giữ hàng lại. Đơn đang huỷ thì kiện bật Cần xử lý "Đơn đang huỷ: dỡ kiện về kệ".',
    security: bearer,
    request: { params: PackageParams, body: { content: { 'application/json': { schema: UndoHandoverBody } } } },
    responses: {
      200: { description: 'Kiện sau khi huỷ bàn giao', ...json(Package) },
      ...auth,
      404: problemResponse('`not_found`: không có hoặc của công ty khác'),
      409: problemResponse('`version_conflict` kèm `current`, `invalid_transition`, `handover_confirmed_by_platform`'),
      422: problemResponse('`reason_required`, `validation_failed`'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/packages/:id/receive-return',
    summary: 'Kho quét nhận hàng hoàn (§19.2)',
    description:
      'Cần `fulfillment.order.process`. Kiện `returning` → `returned`. `code` là mã kiện hoặc mã vận đơn, không phân biệt hoa thường. Dòng đã ghép SKU vào một phiếu kiểm hàng hoàn `KT` nháp (tồn đổi khi phiếu ghi sổ); không dòng nào ghép thì không lập phiếu. Phát `fulfillment.package_returned`.',
    security: bearer,
    request: { params: PackageParams, body: { content: { 'application/json': { schema: ReceiveReturnBody } } } },
    responses: {
      200: { description: 'Kiện sau khi nhận hàng hoàn', ...json(Package) },
      ...auth,
      404: problemResponse('`not_found`: không có hoặc của công ty khác'),
      409: problemResponse('`version_conflict` kèm `current`, `invalid_transition` (kiện không ở `returning`, kể cả quét lần hai)'),
      422: problemResponse('`package_mismatch`: mã quét không phải của kiện này (`errors.code`); `validation_failed`'),
    },
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
