import type { OpenAPIRegistry, RouteConfig } from '@asteasolutions/zod-to-openapi';
import type { z } from 'zod';
import { problemResponse } from '../../../../shared/http/openapi.ts';
import {
  DocActionBody,
  DocActionParams,
  DocCreateBody,
  DocDecideBody,
  DocListQuery,
  DocParams,
  DocUpdateBody,
  ReorderRuleBody,
  StockDetail,
  StockDoc,
  StockDocPage,
  StockLevel,
  StockListQuery,
  StockPage,
  VariantParams,
} from './schemas.ts';

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

  // Phiếu kho có duyệt (§15.2–15.4, #208)
  path({
    method: 'get',
    path: '/documents',
    summary: 'Danh sách phiếu kho (kiểm kê, xuất huỷ, chuyển chờ xử lý, kiểm hàng về), mới trước',
    request: { query: DocListQuery },
    responses: { 200: json('Một trang phiếu', StockDocPage), ...invalid },
  });
  path({
    method: 'get',
    path: '/documents/:id',
    summary: 'Chi tiết phiếu kho kèm dòng, lịch sử, phiếu sinh tiếp',
    request: { params: DocParams },
    responses: { 200: json('Phiếu', StockDoc), ...missing('phiếu kho') },
  });
  path({
    method: 'post',
    path: '/documents',
    summary: 'Lập phiếu nháp (quyền `inventory.receipt.create`); kiểm kê chụp tồn sổ của ngăn lúc lưu',
    request: { body: body(DocCreateBody) },
    responses: { 201: json('Phiếu nháp', StockDoc), ...invalid },
  });
  path({
    method: 'put',
    path: '/documents/:id',
    summary: 'Sửa phiếu nháp (thay toàn bộ dòng); kiểm hàng về: số quét và chia bán lại, hỏng, trả NCC',
    request: { params: DocParams, body: body(DocUpdateBody) },
    responses: {
      200: json('Phiếu', StockDoc),
      ...invalid,
      ...missing('phiếu kho'),
      ...conflict('`version_conflict` kèm `current`; `not_draft`'),
    },
  });
  path({
    method: 'post',
    path: '/documents/:id/decide',
    summary: 'Chọn cách xử lý hàng của xuất huỷ chờ xử lý bị từ chối: nhập lại tồn hoặc lập phiếu trả NCC nháp',
    request: { params: DocParams, body: body(DocDecideBody) },
    responses: {
      200: json('Phiếu', StockDoc),
      ...invalid,
      ...missing('phiếu kho'),
      ...conflict('`decision_made`; `invalid_transition` khi phiếu không cần chọn; `version_conflict`'),
    },
  });
  path({
    method: 'post',
    path: '/documents/:id/:action',
    summary: 'Thao tác theo máy trạng thái §15.3 (submit, approve, reject, post, cancel)',
    description:
      'Duyệt, từ chối: người khác người lập (kiểm hàng về: khác người gửi duyệt phần thiếu), CEO hoặc công ty một người tự duyệt được (`selfApproved`). Gửi duyệt phiếu giảm thiếu hàng: 422 `stock_insufficient` theo dòng.',
    request: { params: DocActionParams, body: body(DocActionBody) },
    responses: {
      200: json('Phiếu', StockDoc),
      422: problemResponse('`reason_required`, `stock_insufficient` (`errors` theo dòng), `validation_failed`'),
      ...missing('phiếu kho'),
      ...conflict(
        '`invalid_transition` kèm `current`, `second_person_required`, `empty_document`, `shortage_needs_review`, `no_shortage`, `version_conflict`',
      ),
    },
  });
}
