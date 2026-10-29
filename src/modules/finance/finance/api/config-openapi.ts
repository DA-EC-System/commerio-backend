import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { problemResponse } from '../../../../shared/http/openapi.ts';
import {
  ConfigActionBody,
  ConfigActionParams,
  ConfigListQuery,
  CreateConfigBody,
  FinanceConfig,
  FinanceConfigPage,
  UpdateConfigBody,
} from './config-schemas.ts';
import { IdParams, VersionBody } from './schemas.ts';

const json = <T>(schema: T) => ({ content: { 'application/json': { schema } } });
const bearer = [{ bearerAuth: [] }];
const auth = {
  401: problemResponse('`unauthorized`'),
  403: problemResponse('`company_not_selected`, `company_locked`, `account_locked`, `module_disabled`, `forbidden`'),
};
const VIEW = 'Cần một trong `finance.config.*`, `finance.settlement.*`, `finance.invoice.view`.';
const MANAGE = 'Cần `finance.config.manage`.';
const notFound = problemResponse('`not_found`: phiên bản cấu hình không có hoặc của công ty khác');
const invalid = problemResponse('`validation_failed` kèm `errors` theo ô (`payload.<trường>` khi nội dung sai theo `kind`)');

/** Swagger của phiên bản cấu hình tiền (Documents/21 §21.4; #118), tương đối với /api/v1/finance. */
export function registerConfigOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/configs',
    summary: 'Phiên bản cấu hình phí, thuế, ngưỡng lệch, biên tối thiểu',
    description: VIEW,
    security: bearer,
    request: { query: ConfigListQuery },
    responses: { 200: { description: 'Trang phiên bản', ...json(FinanceConfigPage) }, ...auth, 422: invalid },
  });
  registry.registerPath({
    method: 'get',
    path: '/configs/:id',
    summary: 'Một phiên bản kèm lịch sử trạng thái',
    description: VIEW,
    security: bearer,
    request: { params: IdParams },
    responses: { 200: { description: 'Phiên bản', ...json(FinanceConfig) }, ...auth, 404: notFound },
  });
  registry.registerPath({
    method: 'post',
    path: '/configs',
    summary: 'Soạn phiên bản nháp',
    description: `${MANAGE} \`fee\` cần \`shopId\`, loại khác không có. Bản sửa lỗi (\`isCorrection\`) cần \`supersedesId\` cùng loại, cùng gian hàng.`,
    security: bearer,
    request: { body: json(CreateConfigBody) },
    responses: { 201: { description: 'Phiên bản nháp', ...json(FinanceConfig) }, ...auth, 422: invalid },
  });
  registry.registerPath({
    method: 'put',
    path: '/configs/:id',
    summary: 'Sửa phiên bản nháp',
    description: `${MANAGE} Chỉ \`draft\`; xoá kết quả chạy thử cũ.`,
    security: bearer,
    request: { params: IdParams, body: json(UpdateConfigBody) },
    responses: {
      200: { description: 'Phiên bản', ...json(FinanceConfig) },
      ...auth,
      404: notFound,
      409: problemResponse('`version_conflict` kèm `current`; `invalid_transition` khi không còn là nháp'),
      422: invalid,
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/configs/:id/dry-run',
    summary: 'Chạy thử: lãi 30 ngày gần nhất nếu áp phiên bản này, không ghi sổ',
    description: `${MANAGE} Chỉ \`draft\`.`,
    security: bearer,
    request: { params: IdParams, body: json(VersionBody) },
    responses: {
      200: { description: 'Phiên bản kèm `dryRun`', ...json(FinanceConfig) },
      ...auth,
      404: notFound,
      409: problemResponse('`version_conflict`; `invalid_transition`'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/configs/:id/:action',
    summary: 'Gửi duyệt, trả về, duyệt, từ chối, huỷ',
    description:
      'Quyền theo bước: `submit`, `cancel` cần `finance.config.manage`; `approve`, `request-changes`, `reject` cần ' +
      '`finance.config.approve`, người làm khác người soạn (CEO tự duyệt được). Duyệt bản đã tới ngày hiệu lực thì áp dụng ngay.',
    security: bearer,
    request: { params: ConfigActionParams, body: json(ConfigActionBody) },
    responses: {
      200: { description: 'Phiên bản sau thao tác', ...json(FinanceConfig) },
      ...auth,
      404: notFound,
      409: problemResponse(
        '`invalid_transition` kèm `current`; `second_person_required`; `version_conflict`; `config_overlap` (trùng ngày hiệu lực cùng ô); `config_already_effective` (huỷ bản đã tới ngày)',
      ),
      422: problemResponse('`dry_run_required` (gửi duyệt khi chưa chạy thử); `reason_required`; `validation_failed`'),
    },
  });
}
