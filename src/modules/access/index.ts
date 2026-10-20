// API công khai của module `access`: vai trò có sẵn và tuỳ biến, quyền chi tiết.
// Module khác chỉ được import từ file này.
import { requireCompanyId } from '../../shared/db/client.ts';
import type { ModuleDefinition } from '../../shared/module.ts';
import { registerAccessOpenApi } from './api/openapi.ts';
import { accessRouter } from './api/routes.ts';
import { BUILTIN_ROLES, permissionModule } from './domain/catalog.ts';
import {
  insertMemberRole,
  memberRoleRows,
  membershipIdsWithRole as membershipIdsWithRoleRows,
  replaceMemberRoleRows,
  rolePermissionRows,
  rolesWithPermissionRows,
} from './repository/roles.ts';

export const accessModule: ModuleDefinition = { name: 'access' };

// Không gắn tại /api/v1/access: identity gắn router này dưới /api/v1/identity (/identity/roles, /identity/permissions).
export { accessRouter, registerAccessOpenApi };

export { BUILTIN_ROLES, permissionModule };
export const assignRole = insertMemberRole;

export interface RolesAndPermissions {
  roles: string[];
  permissions: string[];
}

/** Tên vai trò và hợp các quyền của từng membership. */
export async function rolesAndPermissions(membershipIds: readonly string[]): Promise<Map<string, RolesAndPermissions>> {
  const result = new Map<string, { roles: Set<string>; permissions: Set<string> }>();
  for (const row of await rolePermissionRows(membershipIds)) {
    let entry = result.get(row.membershipId);
    if (!entry) result.set(row.membershipId, (entry = { roles: new Set(), permissions: new Set() }));
    entry.roles.add(row.roleName);
    if (row.permissionCode) entry.permissions.add(row.permissionCode);
  }
  return new Map(
    [...result].map(([id, e]) => [id, { roles: [...e.roles].sort(), permissions: [...e.permissions].sort() }]),
  );
}

/** Vai trò kèm quyền, để staff kiểm luật gán vai trò (#7 [B], [C]). */
export interface RoleWithPermissions {
  id: string;
  name: string;
  isCeo: boolean;
  permissions: string[];
}

const withCeoFlag = (r: { id: string; name: string; permissions: string[] }): RoleWithPermissions => ({
  ...r,
  isCeo: r.id === BUILTIN_ROLES.ceo.id,
});

/**
 * Vai trò có sẵn và vai trò tuỳ biến của công ty đang chọn trong `roleIds` (RLS ẩn vai trò của công ty khác);
 * id không thấy thì không có trong kết quả. Chạy trong `withCompany` của bên gọi.
 */
export async function findRolesWithPermissions(roleIds: readonly string[]): Promise<RoleWithPermissions[]> {
  requireCompanyId('findRolesWithPermissions');
  return (await rolesWithPermissionRows([...new Set(roleIds)])).map(withCeoFlag);
}

/** Vai trò của từng membership; membership không có vai trò thì không có trong Map. Chạy trong `withCompany`. */
export async function memberRolesOf(membershipIds: readonly string[]): Promise<Map<string, RoleWithPermissions[]>> {
  requireCompanyId('memberRolesOf');
  const pairs = await memberRoleRows(membershipIds);
  const found = await rolesWithPermissionRows([...new Set(pairs.map((p) => p.roleId))]);
  const byId = new Map(found.map((r) => [r.id, withCeoFlag(r)]));
  const result = new Map<string, RoleWithPermissions[]>();
  for (const { membershipId, roleId } of pairs) {
    const role = byId.get(roleId);
    if (role) result.set(membershipId, [...(result.get(membershipId) ?? []), role]);
  }
  for (const list of result.values()) list.sort((x, y) => x.name.localeCompare(y.name, 'vi'));
  return result;
}

/**
 * Thay trọn vai trò của membership (xoá rồi gán) trong giao dịch của bên gọi. Vai trò tuỳ biến của công ty khác hay
 * membership của công ty khác: DB ném 23503 `member_roles_company_fk`, bên gọi đổi ra lỗi cho người dùng.
 */
export async function replaceMemberRoles(membershipId: string, companyId: string, roleIds: readonly string[]): Promise<void> {
  requireCompanyId('replaceMemberRoles');
  await replaceMemberRoleRows(membershipId, companyId, [...new Set(roleIds)]);
}

/** Membership trong công ty đang chọn có mang vai trò `roleId` (lọc danh sách nhân viên). Chạy trong `withCompany`. */
export async function membershipIdsWithRole(roleId: string): Promise<string[]> {
  requireCompanyId('membershipIdsWithRole');
  return membershipIdsWithRoleRows(roleId);
}
