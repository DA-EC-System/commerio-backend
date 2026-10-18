// API công khai của module `access`: vai trò có sẵn và tuỳ biến, quyền chi tiết.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../shared/module.ts';
import { registerAccessOpenApi } from './api/openapi.ts';
import { accessRouter } from './api/routes.ts';
import { BUILTIN_ROLES, permissionModule } from './domain/catalog.ts';
import { insertMemberRole, rolePermissionRows } from './repository/roles.ts';

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
