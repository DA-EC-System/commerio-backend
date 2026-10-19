import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { problemResponse } from '../../../shared/http/openapi.ts';
import { IdParams } from './schemas.ts';
import {
  SettlementImportBody,
  SettlementLineListQuery,
  SettlementLinePage,
  SettlementListQuery,
  SettlementPage,
  SettlementStatement,
} from './settlement-schemas.ts';

const json = <T>(schema: T) => ({ content: { 'application/json': { schema } } });
const bearer = [{ bearerAuth: [] }];
const auth = {
  401: problemResponse('`unauthorized`'),
  403: problemResponse(
    '`company_not_selected`, `company_locked`, `account_locked`, `forbidden`, `module_disabled` (phân hệ Kênh bán tắt)',
  ),
};
const invalid = problemResponse('`validation_failed` kèm `errors` theo ô');
const VIEW = 'Cần `finance.invoice.view` và phân hệ Kênh bán bật.';

/** Đường dẫn đối soát tiền sàn (Documents/21 §12.6), tương đối với /api/v1/finance. */
export function registerSettlementOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/settlements',
    summary: 'Bảng kê thanh toán của sàn, mới nhất trước (`from`/`to` theo `statementTime`, giờ VN)',
    description: VIEW,
    security: bearer,
    request: { query: SettlementListQuery },
    responses: { 200: { description: 'Trang bảng kê', ...json(SettlementPage) }, ...auth, 422: invalid },
  });
  registry.registerPath({
    method: 'get',
    path: '/settlements/:id',
    summary: 'Một bảng kê',
    description: VIEW,
    security: bearer,
    request: { params: IdParams },
    responses: {
      200: { description: 'Bảng kê', ...json(SettlementStatement) },
      ...auth,
      404: problemResponse('`not_found`: bảng kê không có hoặc của công ty khác'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/settlement-lines',
    summary: 'Dòng đối soát (không có `statementId` thì `from`/`to` lọc theo `statementTime`)',
    description: `${VIEW} Nhãn "sàn đã hoàn" của một đơn: \`?orderId=\` và \`matchStatus = refund_tagged\`.`,
    security: bearer,
    request: { query: SettlementLineListQuery },
    responses: { 200: { description: 'Trang dòng đối soát', ...json(SettlementLinePage) }, ...auth, 422: invalid },
  });
  registry.registerPath({
    method: 'post',
    path: '/settlements/dev/import',
    summary: 'Nhận bảng kê khuôn OAS TikTok (chỉ môi trường không phải production)',
    description:
      'Cần `finance.voucher.create` và phân hệ Kênh bán bật. Đi đúng đường đối soát (khớp đơn, nhãn hoàn, phiếu thu khi `PAID`); dùng cho demo, E2E khi chưa có sàn giả lập. Không có ở production.',
    security: bearer,
    request: { body: json(SettlementImportBody) },
    responses: {
      201: { description: 'Bảng kê mới', ...json(SettlementStatement) },
      200: {
        description: 'Bảng kê đã có, đã nhận lại (cập nhật trạng thái, thêm dòng mới)',
        ...json(SettlementStatement),
      },
      ...auth,
      422: problemResponse(
        '`errors.shopId` (gian hàng không thuộc công ty, hoặc bảng kê đã nhận cho gian hàng khác), `errors["statement.<trường>"]`, `errors["transactions.<i>.<trường>"]`',
      ),
    },
  });
}
