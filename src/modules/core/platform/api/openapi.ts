import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { problemResponse } from '../../../../shared/http/openapi.ts';
import {
  Company,
  CompanyListQuery,
  CompanyModule,
  CompanyPage,
  CompanyParams,
  LockCompanyBody,
  ModuleParams,
  PlatformAuditPage,
  PlatformAuditQuery,
  PlatformOverview,
  SetModuleBody,
  SetModuleResult,
  UnlockCompanyBody,
} from './schemas.ts';

const json = <T>(schema: T) => ({ content: { 'application/json': { schema } } });
const bearer = [{ bearerAuth: [] }];
const adminAuth = {
  401: problemResponse('`unauthorized`'),
  403: problemResponse('`forbidden` (không phải quản trị nền tảng), `password_change_required`'),
};
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

  const adminOnly = 'Chỉ tài khoản quản trị nền tảng (`core.accounts.is_platform_admin`, đọc mỗi request).';
  registry.registerPath({
    method: 'get',
    path: '/overview',
    summary: 'Tổng quan nền tảng (UC-PI-08)',
    description: `${adminOnly} \`recentActivities\`: năm dòng nhật ký nền tảng mới nhất.`,
    security: bearer,
    responses: { 200: { description: 'Tổng quan', ...json(PlatformOverview) }, ...adminAuth },
  });
  registry.registerPath({
    method: 'get',
    path: '/companies',
    summary: 'Danh sách công ty',
    description: `${adminOnly} Mới đăng ký trước. \`search\` theo tên, mã số thuế, email CEO. CEO là người đăng ký.`,
    security: bearer,
    request: { query: CompanyListQuery },
    responses: {
      200: { description: 'Trang công ty', ...json(CompanyPage) },
      ...adminAuth,
      422: problemResponse('`validation_failed`'),
    },
  });
  for (const [action, body, summary] of [
    ['lock', LockCompanyBody, 'Khoá công ty: thành viên nhận 403 `company_locked` ngay ở request kế tiếp'],
    ['unlock', UnlockCompanyBody, 'Mở khoá công ty'],
  ] as const) {
    registry.registerPath({
      method: 'post',
      path: `/companies/:id/${action}`,
      summary,
      description: `${adminOnly} Ghi nhật ký nền tảng.`,
      security: bearer,
      request: { params: CompanyParams, body: json(body) },
      responses: {
        200: { description: 'Công ty sau khi đổi', ...json(Company) },
        ...adminAuth,
        404: problemResponse('`not_found`'),
        409: problemResponse('`version_conflict` kèm `current` (lệch version hoặc đã ở trạng thái đích)'),
        422: problemResponse(action === 'lock' ? '`validation_failed`: `errors.reason`, `errors.version`' : '`validation_failed`'),
      },
    });
  }
  registry.registerPath({
    method: 'get',
    path: '/audit-logs',
    summary: 'Nhật ký cấp nền tảng: đăng ký, khoá, mở khoá công ty',
    description: `${adminOnly} Mới nhất trước. \`search\` theo tên công ty, email người làm; \`from\`, \`to\` theo giờ Việt Nam.`,
    security: bearer,
    request: { query: PlatformAuditQuery },
    responses: {
      200: { description: 'Trang nhật ký', ...json(PlatformAuditPage) },
      ...adminAuth,
      422: problemResponse('`validation_failed`'),
    },
  });
}
