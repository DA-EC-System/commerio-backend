import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import type { z } from 'zod';
import { problemResponse } from '../../../../shared/http/openapi.ts';
import {
  CarrierList, FoundBody, HandOverBody, HandOverResult, OpenBody, PackBody, Package, PackageDocumentsQuery, PackageListQuery,
  PackagePage, PackageParams, PickList, PickListQuery, ReadyBody, ReceiveReturnBody, UndoHandoverBody,
} from './schemas.ts';

const bearer = [{ bearerAuth: [] }];
const json = <T>(schema: T) => ({ content: { 'application/json': { schema } } });
const auth = {
  401: problemResponse('Thiếu, sai hoặc hết hạn token'),
  403: problemResponse('`forbidden`, `company_not_selected`, `module_disabled`'),
};
const packageMissing = problemResponse('`not_found`: kiện không có hoặc thuộc công ty khác');
const marketplaceConflict = '`shop_not_connected`, `marketplace_unauthorized`, `marketplace_rejected`';
const marketplaceUnavailable = problemResponse('`marketplace_unavailable`: sàn tạm thời không phục vụ');
const versionConflict = '`version_conflict` kèm `current`, `invalid_transition`';

function registerPackingAction(
  registry: OpenAPIRegistry, action: 'pack' | 'ready' | 'open', schema: z.ZodType, summary: string, conflicts: string, inputErrors: string,
) {
  registry.registerPath({
    method: 'post',
    path: `/packages/:id/${action}`,
    summary,
    description: 'Cần `fulfillment.order.process`. Kiểm phiên bản và trả bản chi tiết kiện sau thao tác.',
    security: bearer,
    request: { params: PackageParams, body: json(schema) },
    responses: {
      200: { description: 'Kiện sau khi thực hiện thao tác', ...json(Package) },
      ...auth,
      404: packageMissing,
      409: problemResponse(`${versionConflict}, ${conflicts}, ${marketplaceConflict}`),
      422: problemResponse(`${inputErrors}, \`validation_failed\``),
      503: marketplaceUnavailable,
    },
  });
}

/** Đường dẫn Swagger của module `fulfillment`, viết tương đối với /api/v1/fulfillment. */
export function registerFulfillmentOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/pick-list',
    summary: 'Danh sách nhặt hàng',
    description: 'Cần `fulfillment.order.process`. Gộp theo biến thể, hoặc theo SKU nếu chưa ghép. Mặc định lấy tối đa 500 kiện tab Cần đóng gói.',
    security: bearer,
    request: { query: PickListQuery },
    responses: { 200: { description: 'Danh sách nhặt', ...json(PickList) }, ...auth, 422: problemResponse('`validation_failed` tại `errors.ids`') },
  });
  registry.registerPath({
    method: 'get',
    path: '/packages/:id/carriers',
    summary: 'Nhà vận chuyển của kiện',
    description: 'Cần `fulfillment.order.process`. Danh sách rỗng cho đơn tay, sàn tự chọn hoặc sàn không hỗ trợ chọn.',
    security: bearer,
    request: { params: PackageParams },
    responses: {
      200: { description: 'Nhà vận chuyển', ...json(CarrierList) }, ...auth, 404: packageMissing,
      409: problemResponse(`\`item_not_packable\`, ${marketplaceConflict}`),
      422: problemResponse('`marketplace_unsupported`'), 503: marketplaceUnavailable,
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/packages/documents',
    summary: 'In vận đơn PDF',
    description: 'Cần `fulfillment.order.process`. Gộp vận đơn 1–50 kiện thành một PDF, tên tệp theo giờ Việt Nam.',
    security: bearer,
    request: { query: PackageDocumentsQuery },
    responses: {
      200: { description: 'Tệp vận đơn', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } },
      ...auth, 404: packageMissing,
      409: problemResponse(`\`document_not_ready\`, \`package_status_not_allowed\`, \`rts_package_not_found\`, ${marketplaceConflict}`),
      422: problemResponse('`validation_failed` (đầu vào hoặc tổng tệp quá 50 MB), `marketplace_unsupported`'),
      503: marketplaceUnavailable,
    },
  });
  registerPackingAction(registry, 'pack', PackBody, 'Quét và đóng gói kiện',
    '`order_not_processing`, `package_group_not_ready`, `package_status_not_allowed`, `item_not_packable`',
    '`scan_mismatch` tại `errors["lines.<variantId>"]`, `marketplace_unsupported`');
  registerPackingAction(registry, 'ready', ReadyBody, 'Báo kiện sẵn sàng giao',
    '`self_delivery`, `package_group_not_ready`, `rts_package_not_found`, `package_status_not_allowed`', '`marketplace_unsupported`');
  registerPackingAction(registry, 'open', OpenBody, 'Mở lại kiện đã đóng gói',
    '`shop_awaiting_stocktake`, `package_status_not_allowed`', '`insufficient_stock`, `marketplace_unsupported`');

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
      'Cần `fulfillment.order.process`. Kiện `returning` → `returned`. `code` là mã kiện hoặc mã vận đơn, không phân biệt hoa thường. `lines` là số kho quét từng món: gộp với dòng kiện đã ghép SKU (món vắng: quét 0; món ngoài kiện: dự kiến 0; không gửi: coi như quét đủ) vào một phiếu kiểm hàng hoàn `KT` nháp kèm giá vốn dòng kiện; chờ xử lý cộng ngay theo số quét, tồn thực đổi khi phiếu ghi sổ. Không có dòng nào để lập thì không lập phiếu. Phát `fulfillment.package_returned`.',
    security: bearer,
    request: { params: PackageParams, body: { content: { 'application/json': { schema: ReceiveReturnBody } } } },
    responses: {
      200: { description: 'Kiện sau khi nhận hàng hoàn', ...json(Package) },
      ...auth,
      404: problemResponse('`not_found`: không có hoặc của công ty khác'),
      409: problemResponse('`version_conflict` kèm `current`, `invalid_transition` (kiện không ở `returning`, kể cả quét lần hai)'),
      422: problemResponse('`package_mismatch`: mã quét không phải của kiện này (`errors.code`); `validation_failed`: lỗi `lines` theo §15.3 (`lines.<i>.quantity`, `lines.<i>.variantId`)'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/packages/:id/found',
    summary: 'Kho nhận kiện thất lạc tìm thấy (§19.2)',
    description:
      'Cần `fulfillment.order.process`. Kiện `lost` → `returned`. `lines` như `receive-return`: phiếu kiểm hàng hoàn `KT` nháp theo số quét, chờ xử lý cộng ngay. Phát `fulfillment.package_returned`.',
    security: bearer,
    request: { params: PackageParams, body: { content: { 'application/json': { schema: FoundBody } } } },
    responses: {
      200: { description: 'Kiện sau khi nhận về kho', ...json(Package) },
      ...auth,
      404: problemResponse('`not_found`: không có hoặc của công ty khác'),
      409: problemResponse('`version_conflict` kèm `current`, `invalid_transition` (kiện không ở `lost`, kể cả gửi lần hai)'),
      422: problemResponse('`validation_failed`: lỗi `lines` theo §15.3'),
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
