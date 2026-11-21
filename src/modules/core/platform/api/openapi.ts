import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { problemResponse } from '../../../../shared/http/openapi.ts';
import {
  Company,
  CompanyListQuery,
  CompanyModule,
  CompanyPage,
  CompanyParams,
  CompanyProfile,
  DeadJobListQuery,
  DeadJobPage,
  DeadJobParams,
  LockCompanyBody,
  ReleaseTaxCodeBody,
  ModuleParams,
  PlatformAuditPage,
  PlatformAuditQuery,
  PlatformOverview,
  SetModuleBody,
  SetModuleResult,
  UnlockCompanyBody,
  UpdateCompanyProfileBody,
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
    method: 'delete',
    path: '/company',
    summary: 'Xoá công ty thử của e2e',
    description:
      'Chỉ có trên server bật đăng ký thử (`REGISTRATION_TEST_EMAIL_DOMAIN`, staging/test); production trả 404. Xoá công ty '
      + 'trong token và mọi dữ liệu của nó trong một giao dịch, cùng tài khoản miền thử không còn ở công ty nào. Chỉ CEO đang '
      + 'hoạt động; mọi thành viên (cả đã khoá) và lời mời đang chờ phải dùng email miền thử, không ai là quản trị nền tảng. '
      + 'Tệp trên kho lưu trữ giữ nguyên. e2e gọi route này sau mỗi lượt chạy.',
    security: bearer,
    responses: {
      204: { description: 'Đã xoá' },
      401: problemResponse('`unauthorized`'),
      403: problemResponse('`forbidden` (chưa chọn công ty, không phải CEO), `not_test_company`, `password_change_required`'),
      404: problemResponse('`not_found` (server không bật đăng ký thử)'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/company',
    summary: 'Hồ sơ công ty đang chọn (#292)',
    description: 'Cần `platform.company.manage` (CEO, Admin). Tên, mã số thuế chỉ đọc.',
    security: bearer,
    responses: { 200: { description: 'Hồ sơ công ty', ...json(CompanyProfile) }, ...companyAuth },
  });
  registry.registerPath({
    method: 'put',
    path: '/company',
    summary: 'Sửa địa chỉ đăng ký, tổ chức chịu trách nhiệm hàng hoá',
    description:
      'Cần `platform.company.manage`. Ô không gửi thì giữ nguyên, `null` = theo tên, địa chỉ công ty. ' +
      '`effectiveResponsible` là giá trị điền sẵn khi ghép danh mục và lúc đẩy lên sàn. ' +
      '`taxCode` chỉ nhập được khi công ty đang không có mã số thuế (#459); không nhận mã vừa bị gỡ khỏi chính công ty.',
    security: bearer,
    request: { body: json(UpdateCompanyProfileBody) },
    responses: {
      200: { description: 'Hồ sơ sau khi sửa', ...json(CompanyProfile) },
      ...companyAuth,
      409: problemResponse('`version_conflict`, kèm `current`; `tax_code_taken`'),
      422: problemResponse('`validation_failed`; `errors.taxCode` khi sai định dạng, công ty đang có mã, hoặc mã vừa bị gỡ khỏi công ty'),
    },
  });
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
    method: 'post',
    path: '/companies/:id/release-tax-code',
    summary: 'Gỡ mã số thuế của công ty (#459): công ty giữ mã không phải của mình',
    description: `${adminOnly} Ghi nhật ký nền tảng (\`company.tax_code_released\` kèm lý do), gửi thư báo CEO bằng việc nền.`,
    security: bearer,
    request: { params: CompanyParams, body: json(ReleaseTaxCodeBody) },
    responses: {
      200: { description: 'Công ty với `taxCode: null`', ...json(Company) },
      ...adminAuth,
      404: problemResponse('`not_found`'),
      409: problemResponse('`invalid_transition` (đã không có mã số thuế), `version_conflict` kèm `current`'),
      422: problemResponse('`validation_failed`: `errors.reason`, `errors.version`'),
    },
  });
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
  registry.registerPath({
    method: 'get',
    path: '/jobs/dead',
    summary: 'Việc nền lỗi của công ty (#102)',
    description:
      'Việc đã thử hết lượt mà vẫn lỗi, mới nhất trước, giữ 30 ngày. `queue` lọc theo hàng gốc. Cần `platform.job.manage`.',
    security: bearer,
    request: { query: DeadJobListQuery },
    responses: {
      200: { description: 'Một trang việc lỗi', content: { 'application/json': { schema: DeadJobPage } } },
      ...companyAuth,
      422: problemResponse('`validation_failed`'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/jobs/dead/:id/retry',
    summary: 'Chạy lại một việc lỗi (#102)',
    description: 'Đưa việc về hàng gốc với lượt thử mới, ghi nhật ký thao tác. Cần `platform.job.manage`.',
    security: bearer,
    request: { params: DeadJobParams },
    responses: {
      204: { description: 'Việc đã về hàng gốc' },
      ...companyAuth,
      404: problemResponse('`not_found`: không còn trong hàng việc lỗi hoặc của công ty khác'),
    },
  });
}
