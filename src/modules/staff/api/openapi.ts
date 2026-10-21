import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { problemResponse } from '../../../shared/http/openapi.ts';
import { ChangeRolesBody, StaffListQuery, StaffMemberSchema, StaffPage, StaffParams, VersionBody } from './schemas.ts';

const json = <T>(schema: T) => ({ content: { 'application/json': { schema } } });
const bearer = [{ bearerAuth: [] }];

/** Đường dẫn Swagger của module `staff`, viết tương đối với /api/v1/identity (identity gọi hàm này). */
export function registerStaffOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/staff',
    summary: 'Danh sách nhân viên trong công ty (UC-PI-05)',
    description: '`search` tìm theo họ tên, email, không phân biệt hoa thường. Cần `identity.account.view`.',
    security: bearer,
    request: { query: StaffListQuery },
    responses: {
      200: { description: 'Một trang nhân viên', ...json(StaffPage) },
      403: problemResponse('`forbidden`, `company_not_selected`, `company_locked`, `account_locked`'),
      422: problemResponse('`validation_failed`'),
    },
  });
  registry.registerPath({
    method: 'put',
    path: '/staff/:accountId/roles',
    summary: 'Đổi vai trò của nhân viên (UC-PI-05)',
    description:
      'Thay trọn danh sách vai trò. Không đụng CEO, chính mình; không gán CEO; không thêm hay gỡ vai trò có quyền ' +
      'người gọi không có. Cần `identity.account.manage`.',
    security: bearer,
    request: { params: StaffParams, body: json(ChangeRolesBody) },
    responses: {
      200: { description: 'Nhân viên sau khi đổi', ...json(StaffMemberSchema) },
      403: problemResponse('`protected_account`, `permission_not_held`, `forbidden`'),
      404: problemResponse('`not_found`: không có trong công ty'),
      409: problemResponse('`version_conflict` kèm `current`'),
      422: problemResponse('`validation_failed` (`errors.roleIds`, `errors.version`)'),
    },
  });
  for (const [action, summary] of [
    ['lock', 'Tạm khoá nhân viên trong công ty (UC-PI-05)'],
    ['unlock', 'Mở khoá nhân viên trong công ty (UC-PI-05)'],
  ] as const) {
    registry.registerPath({
      method: 'post',
      path: `/staff/:accountId/${action}`,
      summary,
      description: 'Có hiệu lực ngay với mọi API của người đó. Cần `identity.account.manage`.',
      security: bearer,
      request: { params: StaffParams, body: json(VersionBody) },
      responses: {
        200: { description: 'Nhân viên sau khi đổi', ...json(StaffMemberSchema) },
        403: problemResponse('`protected_account`, `forbidden`'),
        404: problemResponse('`not_found`'),
        409: problemResponse('`version_conflict` kèm `current` (lệch version hoặc đã ở trạng thái đích)'),
        422: problemResponse('`validation_failed`'),
      },
    });
  }
}
