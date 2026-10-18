import { eq, inArray } from 'drizzle-orm';
import { getDb } from '../../../shared/db/client.ts';
import { memberRoles, rolePermissions, roles } from './schema.ts';

export async function insertMemberRole(input: { membershipId: string; roleId: string; companyId: string }): Promise<void> {
  await getDb().insert(memberRoles).values(input);
}

/** Mỗi dòng là một cặp (membership, vai trò, quyền); vai trò không có quyền vẫn có một dòng với quyền null. */
export async function rolePermissionRows(membershipIds: readonly string[]) {
  if (membershipIds.length === 0) return [];
  return getDb()
    .select({
      membershipId: memberRoles.membershipId,
      roleName: roles.name,
      permissionCode: rolePermissions.permissionCode,
    })
    .from(memberRoles)
    .innerJoin(roles, eq(roles.id, memberRoles.roleId))
    .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .where(inArray(memberRoles.membershipId, [...membershipIds]));
}
