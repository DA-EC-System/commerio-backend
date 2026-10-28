import type { OpenAPIRegistry, RouteConfig } from '@asteasolutions/zod-to-openapi';
import type { z } from 'zod';
import { problemResponse } from '../../../../shared/http/openapi.ts';
import {
  CreateDocBody,
  DocListQuery,
  IdParams,
  ReorderRuleBody,
  StockDetail,
  StockDoc,
  StockDocPage,
  StockLevel,
  StockListQuery,
  StockPage,
  UpdateDocBody,
  VariantParams,
  VersionBody,
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

/** Đường dẫn Swagger của module `inventory`, tương đối với /api/v1/inventory (Documents/21 7.1, 7.2). */
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
  path({
    method: 'get',
    path: '/documents',
    summary: 'Danh sách phiếu nhập/xuất, mới nhất trước',
    request: { query: DocListQuery },
    responses: { 200: json('Một trang phiếu', StockDocPage), ...invalid },
  });
  path({
    method: 'get',
    path: '/documents/:id',
    summary: 'Một phiếu kèm dòng (giá trên dòng theo quyền, Documents/21 K3)',
    request: { params: IdParams },
    responses: { 200: json('Phiếu', StockDoc), ...missing('phiếu kho') },
  });
  path({
    method: 'post',
    path: '/documents',
    summary: 'Lập phiếu nhập/xuất tay ở trạng thái nháp (quyền `inventory.receipt.create`)',
    request: { body: body(CreateDocBody) },
    responses: { 201: json('Phiếu nháp', StockDoc), ...invalid },
  });
  path({
    method: 'put',
    path: '/documents/:id',
    summary: 'Sửa phiếu nháp lập tay',
    request: { params: IdParams, body: body(UpdateDocBody) },
    responses: {
      200: json('Phiếu sau khi sửa', StockDoc),
      ...missing('phiếu kho'),
      ...conflict('`version_conflict` (kèm `current`) hoặc `not_draft`'),
      ...invalid,
    },
  });
  path({
    method: 'post',
    path: '/documents/:id/post',
    summary: 'Ghi sổ phiếu nháp: tồn đổi ngay, khoá dòng tồn (Documents/21 K10)',
    request: { params: IdParams, body: body(VersionBody) },
    responses: {
      200: json('Phiếu đã ghi sổ', StockDoc),
      ...missing('phiếu kho'),
      ...conflict('`version_conflict` (kèm `current`) hoặc `not_draft`'),
      422: problemResponse('`insufficient_stock` (`errors["lines.<i>.quantity"]`) hoặc dữ liệu không hợp lệ'),
    },
  });
  path({
    method: 'post',
    path: '/documents/:id/cancel',
    summary: 'Huỷ phiếu nháp; tồn không đổi',
    request: { params: IdParams, body: body(VersionBody) },
    responses: {
      200: json('Phiếu đã huỷ', StockDoc),
      ...missing('phiếu kho'),
      ...conflict('`version_conflict` (kèm `current`) hoặc `not_draft`'),
      ...invalid,
    },
  });
}
