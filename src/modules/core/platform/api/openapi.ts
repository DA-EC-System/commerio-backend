import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { problemResponse } from '../../../../shared/http/openapi.ts';
import { CompanyModule, ModuleParams, SetModuleBody, SetModuleResult } from './schemas.ts';

const json = <T>(schema: T) => ({ content: { 'application/json': { schema } } });
const bearer = [{ bearerAuth: [] }];
const companyAuth = {
  401: problemResponse('`unauthorized`'),
  403: problemResponse('`company_not_selected`, `company_locked`, `account_locked`, `forbidden`'),
};

/** Đường dẫn Swagger của module `platform`, viết tương đối với /api/v1/platform. */
export function registerPlatformOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/modules',
    summary: 'Năm phân hệ tuỳ chọn của công ty đang chọn (UC-PI-02)',
    description: 'Cần `platform.module.manage` (CEO). Phân hệ đang tắt có `enabledAt`, `enabledBy`, `aiConsent*` là `null`.',
    security: bearer,
    responses: { 200: { description: 'Phân hệ tuỳ chọn', ...json(z.array(CompanyModule)) }, ...companyAuth },
  });
  registry.registerPath({
    method: 'put',
    path: '/modules/:code',
    summary: 'Bật hoặc tắt một phân hệ tuỳ chọn',
    description:
      'Cần `platform.module.manage`. `enabled` là trạng thái muốn chuyển tới. Bật `assistant` cần `aiConsent: true`. ' +
      'Phân hệ đã có dữ liệu không tắt được (`report` luôn tắt được). Tắt xong, API của phân hệ trả 403 `module_disabled` ngay.',
    security: bearer,
    request: { params: ModuleParams, body: json(SetModuleBody) },
    responses: {
      200: { description: 'Phân hệ sau khi đổi và danh sách phân hệ đang bật', ...json(SetModuleResult) },
      ...companyAuth,
      404: problemResponse('`module_not_found` (phân hệ lõi hoặc mã lạ)'),
      409: problemResponse('`module_state_changed` hoặc `module_has_data`, kèm `current`'),
      422: problemResponse('`validation_failed`, `ai_consent_required`'),
    },
  });
}
