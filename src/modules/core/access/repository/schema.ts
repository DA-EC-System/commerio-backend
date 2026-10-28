import { sql } from 'drizzle-orm';
import { check, index, pgSchema, primaryKey, text, unique, uuid } from 'drizzle-orm/pg-core';
import { timestamps, version } from '../../../../shared/db/columns.ts';

// Mọi bảng của module `access` khai báo trong schema này.
export const accessSchema = pgSchema('access');

export const roleKind = accessSchema.enum('role_kind', ['builtin', 'custom']);

/** Danh mục quyền (Documents/21 mục 8). Dùng chung mọi công ty, không có RLS; seed bằng migration. */
export const permissions = accessSchema.table('permissions', {
  code: text('code').primaryKey(),
  // Mã phân hệ của quyền; quyền chỉ có hiệu lực khi phân hệ đó đang bật.
  moduleCode: text('module_code').notNull(),
  description: text('description').notNull(),
});

/**
 * Vai trò có sẵn có `company_id` trống, dùng chung mọi công ty; vai trò tuỳ biến thuộc một công ty.
 * Tên không trùng theo chữ thường: index `roles_company_lower_name_uq` viết tay ở migration 0005 (Drizzle không sinh được).
 * `kind` ràng với `company_id`: có sẵn thì trống công ty, tuỳ biến thì có (#62).
 */
export const roles = accessSchema.table(
  'roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id'),
    name: text('name').notNull(),
    kind: roleKind('kind').notNull(),
    ...timestamps,
    ...version,
  },
  (t) => [
    unique().on(t.companyId, t.name).nullsNotDistinct(),
    check('roles_kind_company_check', sql`(${t.kind} = 'builtin') = (${t.companyId} is null)`),
  ],
);

export const rolePermissions = accessSchema.table(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionCode: text('permission_code')
      .notNull()
      .references(() => permissions.code),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionCode] })],
);

/**
 * Vai trò của một membership (staff.memberships, không đặt khoá ngoại chéo module).
 * Có `company_id` để RLS lọc thẳng, không phải tra sang staff. Trigger `member_roles_company_fk` (migration 0017,
 * viết tay) bắt vai trò trống công ty hoặc cùng công ty, và membership cùng công ty (#62).
 */
export const memberRoles = accessSchema.table(
  'member_roles',
  {
    membershipId: uuid('membership_id').notNull(),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id),
    companyId: uuid('company_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.membershipId, t.roleId] }), index().on(t.roleId)],
);
