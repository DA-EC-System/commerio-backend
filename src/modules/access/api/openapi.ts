import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { problemResponse } from '../../../shared/http/openapi.ts';
import { DeleteRoleQuery, PermissionDef, Role, RoleBody, RoleParams, UpdateRoleBody } from './schemas.ts';

const json = <T>(schema: T) => ({ content: { 'application/json': { schema } } });
const bearer = [{ bearerAuth: [] }];
const auth = {
  401: problemResponse('`unauthorized`'),
  403: problemResponse('`company_not_selected`, `company_locked`, `account_locked`, `forbidden`'),
};

/** Đường dẫn Swagger của module `access`, viết tương đối với /api/v1/identity (identity gọi hàm này). */
export function registerAccessOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/permissions',
    summary: 'Danh mục quyền cấp được cho vai trò tuỳ biến (phân hệ đang bật)',
    description: 'Cần `identity.role.view`. Không có hai quyền `platform.*` (chỉ vai trò có sẵn mang).',
    security: bearer,
    responses: { 200: { description: 'Danh mục quyền', ...json(z.array(PermissionDef)) }, ...auth },
  });
  registry.registerPath({
    method: 'get',
    path: '/roles',
    summary: 'Vai trò của công ty (UC-PI-06)',
    description: 'Cần `identity.role.view` hoặc `identity.account.view`. Vai trò có sẵn trước, rồi vai trò tuỳ biến theo tên.',
    security: bearer,
    responses: { 200: { description: 'Danh sách vai trò', ...json(z.array(Role)) }, ...auth },
  });
  registry.registerPath({
    method: 'post',
    path: '/roles',
    summary: 'Tạo vai trò tuỳ biến',
    description: 'Cần `identity.role.manage`. Chỉ chọn được quyền mình đang có, thuộc phân hệ đang bật.',
    security: bearer,
    request: { body: json(RoleBody) },
    responses: {
      201: { description: 'Đã tạo', ...json(Role) },
      ...auth,
      403: problemResponse('Như trên, thêm `permission_not_held`'),
      409: problemResponse('`role_name_taken` kèm `errors.name`'),
      422: problemResponse('`validation_failed`: `errors.name`, `errors.permissions` (kể cả quyền của phân hệ chưa bật)'),
    },
  });
  registry.registerPath({
    method: 'put',
    path: '/roles/:id',
    summary: 'Sửa tên và quyền của vai trò tuỳ biến',
    description:
      'Gửi trọn danh sách quyền và `version`. Quyền của phân hệ đang tắt mà vai trò đang có được giữ nguyên (Documents/21 D2).',
    security: bearer,
    request: { params: RoleParams, body: json(UpdateRoleBody) },
    responses: {
      200: { description: 'Vai trò sau khi sửa', ...json(Role) },
      ...auth,
      403: problemResponse('Như trên, thêm `builtin_role`, `permission_not_held`'),
      404: problemResponse('`not_found`'),
      409: problemResponse('`version_conflict` kèm `current`, hoặc `role_name_taken`'),
      422: problemResponse('`validation_failed`'),
    },
  });
  registry.registerPath({
    method: 'delete',
    path: '/roles/:id',
    summary: 'Xoá vai trò tuỳ biến không còn ai mang',
    security: bearer,
    request: { params: RoleParams, query: DeleteRoleQuery },
    responses: {
      204: { description: 'Đã xoá' },
      ...auth,
      403: problemResponse('Như trên, thêm `builtin_role`, `permission_not_held`'),
      404: problemResponse('`not_found`'),
      409: problemResponse('`version_conflict` kèm `current`, hoặc `role_in_use`'),
      422: problemResponse('`validation_failed`: `errors.version`'),
    },
  });
}
