import { z } from 'zod';
import { GRANTABLE_CODES } from '../domain/roles.ts';

// Quy tắc khớp mock FE `validateRoleInput` (tên 1–60 ký tự, ít nhất một quyền có trong danh mục).
const name = z.string('Nhập tên vai trò').trim().min(1, 'Nhập tên vai trò').max(60, 'Tên vai trò tối đa 60 ký tự');

// Kiểm mã quyền ở cấp mảng để lỗi nằm ở `errors.permissions`, không ở `permissions.<i>` (Documents/21 C1).
const permissions = z
  .array(z.string(), 'Chọn ít nhất một quyền')
  .min(1, 'Chọn ít nhất một quyền')
  .refine((codes) => codes.every((c) => GRANTABLE_CODES.includes(c)), 'Có quyền không tồn tại hoặc không cấp được cho vai trò tuỳ biến')
  .transform((codes) => [...new Set(codes)])
  .meta({ example: ['sales.customer.view', 'inbox.conversation.view'] });

const version = z.number('Thiếu version').int().positive();

export const RoleBody = z.object({ name, permissions }).meta({ id: 'RoleRequest' });

export const UpdateRoleBody = z.object({ name, permissions, version }).meta({ id: 'UpdateRoleRequest' });

// `id` sai định dạng trả 404 ở service (như vai trò không tồn tại), nên ở đây chỉ là chuỗi.
export const RoleParams = z.object({ id: z.string() });

export const DeleteRoleQuery = z.object({ version: z.coerce.number('Thiếu version').int().positive('Thiếu version') });

// Schema trả về, chỉ dùng cho Swagger.
export const PermissionDef = z
  .object({ code: z.string(), module: z.string(), label: z.string() })
  .meta({ id: 'PermissionDef', example: { code: 'identity.role.view', module: 'identity', label: 'Xem vai trò' } });

export const Role = z
  .object({
    id: z.uuid(),
    name: z.string(),
    builtIn: z.boolean().meta({ description: 'Vai trò có sẵn (CEO, Admin, Sale, Nhân viên kho): không sửa, không xoá' }),
    permissions: z.array(z.string()),
    memberCount: z.number().int().meta({ description: 'Số tài khoản trong công ty đang mang vai trò này' }),
    version: z.number().int(),
    updatedAt: z.string(),
  })
  .meta({ id: 'Role' });
