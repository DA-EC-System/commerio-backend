import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { problemResponse } from '../../../../shared/http/openapi.ts';
import { AuditLogParams, AuditLogQuery, CompanyAuditLogDetail, CompanyAuditLogPage } from './schemas.ts';

const json = <T>(schema: T) => ({ content: { 'application/json': { schema } } });
const bearer = [{ bearerAuth: [] }];
const auth = {
  401: problemResponse('`unauthorized`'),
  403: problemResponse('`company_not_selected`, `company_locked`, `account_locked`, `forbidden`'),
};

/** Đường dẫn Swagger của module `audit`, viết tương đối với /api/v1/audit. */
export function registerAuditOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/logs',
    summary: 'Nhật ký thao tác của công ty đang chọn (UC-PI-07)',
    description: 'Cần `platform.audit.view` (CEO, Admin). Mới nhất trước. `from`, `to` trọn ngày theo giờ Việt Nam.',
    security: bearer,
    request: { query: AuditLogQuery },
    responses: {
      200: { description: 'Trang nhật ký', ...json(CompanyAuditLogPage) },
      ...auth,
      422: problemResponse('`validation_failed`'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/logs/:id',
    summary: 'Một dòng nhật ký kèm dữ liệu trước và sau',
    description: 'Cần `platform.audit.view`. Dòng của công ty khác: 404 như không có.',
    security: bearer,
    request: { params: AuditLogParams },
    responses: {
      200: { description: 'Dòng nhật ký', ...json(CompanyAuditLogDetail) },
      ...auth,
      404: problemResponse('`not_found`'),
    },
  });
}
