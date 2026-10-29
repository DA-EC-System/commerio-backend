import type { OpenAPIRegistry, RouteConfig } from '@asteasolutions/zod-to-openapi';
import type { z } from 'zod';
import { problemResponse } from '../../../../shared/http/openapi.ts';
import {
  ActionParams,
  AddRequestLineInput,
  ExcludeLineInput,
  GoodsReceipt,
  GoodsReceiptCreateInput,
  GoodsReceiptPage,
  GoodsReceiptUpdateInput,
  IdParams,
  LineParams,
  PurchaseRequest,
  PurchaseRequestInput,
  PurchaseRequestPage,
  PurchaseRequestUpdateInput,
  ReceiptActionInput,
  ReceiptListQuery,
  RequestActionInput,
  RequestListQuery,
  Supplier,
  SupplierInput,
  SupplierList,
  SupplierListQuery,
  SupplierUpdateInput,
} from './schemas.ts';

const json = (description: string, schema: z.ZodType) => ({ description, content: { 'application/json': { schema } } });
const body = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });

const common = {
  401: problemResponse('Chưa đăng nhập'),
  403: problemResponse('Chưa chọn công ty, phân hệ `purchasing` tắt, hoặc thiếu quyền (`forbidden`)'),
};
const invalid = { 422: problemResponse('Dữ liệu không hợp lệ (`validation_failed`, `errors` theo ô)') };
const missing = (what: string) => ({ 404: problemResponse(`Không tìm thấy ${what} (kể cả của công ty khác)`) });
const conflict = (detail: string) => ({ 409: problemResponse(detail) });
const versionConflict = '`version_conflict`, kèm `current` là bản mới nhất';

/** Đường dẫn Swagger của module `purchasing`, tương đối với /api/v1/purchasing (Documents/21 mục 16.2). */
export function registerPurchasingOpenApi(registry: OpenAPIRegistry): void {
  const path = (route: RouteConfig) => registry.registerPath({ ...route, responses: { ...common, ...route.responses } });

  path({
    method: 'get',
    path: '/suppliers',
    summary: 'Danh sách nhà cung cấp, xếp theo tên (có một quyền `purchasing.*`)',
    request: { query: SupplierListQuery },
    responses: { 200: json('Nhà cung cấp', SupplierList), ...invalid },
  });
  path({
    method: 'post',
    path: '/suppliers',
    summary: 'Thêm nhà cung cấp (quyền `purchasing.request.manage`)',
    request: { body: body(SupplierInput) },
    responses: { 201: json('Nhà cung cấp vừa thêm', Supplier), ...invalid },
  });
  path({
    method: 'put',
    path: '/suppliers/:id',
    summary: 'Sửa nhà cung cấp; ngừng giao dịch bằng `active: false` (quyền `purchasing.request.manage`)',
    request: { params: IdParams, body: body(SupplierUpdateInput) },
    responses: { 200: json('Nhà cung cấp sau khi sửa', Supplier), ...missing('nhà cung cấp'), ...conflict(versionConflict), ...invalid },
  });

  path({
    method: 'get',
    path: '/requests',
    summary: 'Danh sách đề nghị nhập, mới nhất trước (có một quyền `purchasing.*`)',
    request: { query: RequestListQuery },
    responses: { 200: json('Một trang đề nghị nhập', PurchaseRequestPage), ...invalid },
  });
  path({
    method: 'get',
    path: '/requests/:id',
    summary: 'Chi tiết đề nghị nhập: dòng, phiếu nhận, lịch sử trạng thái',
    request: { params: IdParams },
    responses: { 200: json('Đề nghị nhập', PurchaseRequest), ...missing('đề nghị nhập') },
  });
  path({
    method: 'post',
    path: '/requests',
    summary: 'Lập đề nghị nhập nháp (quyền `purchasing.request.manage`)',
    request: { body: body(PurchaseRequestInput) },
    responses: { 201: json('Đề nghị nháp', PurchaseRequest), ...invalid },
  });
  path({
    method: 'post',
    path: '/requests/add-line',
    summary: 'Thêm một SKU từ gợi ý nhập lại vào nháp có sẵn hoặc nháp mới (quyền `purchasing.request.manage`)',
    request: { body: body(AddRequestLineInput) },
    responses: {
      200: json('Đề nghị nháp đã thêm dòng', PurchaseRequest),
      201: json('Đề nghị nháp vừa lập', PurchaseRequest),
      ...invalid,
    },
  });
  path({
    method: 'put',
    path: '/requests/:id',
    summary: 'Sửa đề nghị nháp hoặc bị trả về; thay toàn bộ dòng (quyền `purchasing.request.manage`)',
    request: { params: IdParams, body: body(PurchaseRequestUpdateInput) },
    responses: {
      200: json('Đề nghị sau khi sửa', PurchaseRequest),
      ...missing('đề nghị nhập'),
      ...conflict(`${versionConflict}; \`not_draft\` khi không còn sửa được`),
      ...invalid,
    },
  });
  path({
    method: 'post',
    path: '/requests/:id/lines/:lineId/exclude',
    summary: 'CEO loại hoặc bỏ loại một dòng khi đề nghị chờ duyệt (quyền `purchasing.request.approve`)',
    request: { params: LineParams, body: body(ExcludeLineInput) },
    responses: {
      200: json('Đề nghị sau khi loại dòng', PurchaseRequest),
      ...missing('đề nghị hoặc dòng'),
      ...conflict(`${versionConflict}; \`invalid_transition\` khi không chờ duyệt; \`all_lines_excluded\``),
      ...invalid,
    },
  });
  path({
    method: 'post',
    path: '/requests/:id/:action',
    summary:
      'Chuyển trạng thái: submit, withdraw, resubmit, approve, request_changes, reject, order, close_short, cancel. Quyền theo bước (Documents/21 mục 16.3)',
    request: { params: ActionParams, body: body(RequestActionInput) },
    responses: {
      200: json('Đề nghị sau khi chuyển', PurchaseRequest),
      ...missing('đề nghị hoặc thao tác'),
      ...conflict(
        `${versionConflict}; \`invalid_transition\`, \`second_person_required\`, \`empty_document\`, \`all_lines_excluded\`, \`has_receipts\`, \`receipt_counting\``,
      ),
      422: problemResponse('`validation_failed` (giá nhập 0, tên sản phẩm mới đã có), `reason_required`, `supplier_inactive`'),
    },
  });

  path({
    method: 'get',
    path: '/goods-receipts',
    summary: 'Danh sách phiếu nhận, mới nhất trước; `search` khớp số phiếu, số đề nghị (có một quyền `purchasing.*`)',
    request: { query: ReceiptListQuery },
    responses: { 200: json('Một trang phiếu nhận', GoodsReceiptPage), ...invalid },
  });
  path({
    method: 'get',
    path: '/goods-receipts/:id',
    summary: 'Chi tiết phiếu nhận: dòng kèm còn chờ hiện tại, kết quả giao thiếu, lịch sử trạng thái',
    request: { params: IdParams },
    responses: { 200: json('Phiếu nhận', GoodsReceipt), ...missing('phiếu nhận') },
  });
  path({
    method: 'post',
    path: '/goods-receipts',
    summary: 'Lập phiếu nhận cho đề nghị đã đặt NCC; dòng là các dòng còn chờ (quyền `purchasing.receipt.manage`)',
    request: { body: body(GoodsReceiptCreateInput) },
    responses: {
      201: json('Phiếu đang kiểm', GoodsReceipt),
      ...conflict('`invalid_transition` (`current` là trạng thái đề nghị) khi đề nghị chưa đặt hoặc đã đóng; `empty_document` khi không còn dòng chờ'),
      422: problemResponse('`validation_failed`; `errors.requestId` khi không thấy đề nghị'),
    },
  });
  path({
    method: 'put',
    path: '/goods-receipts/:id',
    summary: 'Lưu số kiểm đếm khi phiếu đang kiểm; `lines[].lineId` là id dòng đề nghị (quyền `purchasing.receipt.manage`)',
    request: { params: IdParams, body: body(GoodsReceiptUpdateInput) },
    responses: {
      200: json('Phiếu sau khi lưu', GoodsReceipt),
      ...missing('phiếu nhận'),
      ...conflict(`${versionConflict}; \`not_draft\` khi phiếu không còn đang kiểm`),
      422: problemResponse('`validation_failed` theo ô (`lines.i.accepted`, `lines.i.reason`, `lines.i.lineId`, `attachments`); `over_outstanding`'),
    },
  });
  path({
    method: 'post',
    path: '/goods-receipts/:id/:action',
    summary: 'Chuyển trạng thái: post, post_short, cancel. Quyền theo bước (Documents/21 mục 16.3)',
    request: { params: ActionParams, body: body(ReceiptActionInput) },
    responses: {
      200: json('Phiếu sau khi chuyển', GoodsReceipt),
      ...missing('phiếu nhận hoặc thao tác'),
      ...conflict(`${versionConflict}; \`invalid_transition\`, \`second_person_required\`, \`has_shortage\`, \`no_shortage\`, \`empty_document\``),
      422: problemResponse('`reason_required`; `over_outstanding` theo ô'),
    },
  });
}
