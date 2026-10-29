import { and, count, eq, inArray, ne, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
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

// Các hàm dưới đây chạy trong withCompany: RLS chỉ cho thấy vai trò có sẵn và vai trò của công ty đang chọn.

const roleColumns = {
  id: roles.id,
  companyId: roles.companyId,
  name: roles.name,
  version: roles.version,
  updatedAt: roles.updatedAt,
};

export type RoleRow = { id: string; companyId: string | null; name: string; version: number; updatedAt: Date };

/** Vai trò thấy được, kèm quyền và số người mang (trong công ty). Không truyền `id` thì lấy tất cả. */
export async function findRoles(id?: string) {
  const db = getDb();
  const rows: RoleRow[] = await db
    .select(roleColumns)
    .from(roles)
    .where(id ? eq(roles.id, id) : undefined);
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];
  // Tuần tự: hai câu cùng một kết nối giao dịch, pg không cho chạy song song.
  const perms = await db
    .select({ roleId: rolePermissions.roleId, code: rolePermissions.permissionCode })
    .from(rolePermissions)
    .where(inArray(rolePermissions.roleId, ids));
  const members = await db
    .select({ roleId: memberRoles.roleId, n: count() })
    .from(memberRoles)
    .where(inArray(memberRoles.roleId, ids))
    .groupBy(memberRoles.roleId);
  return rows.map((r) => ({
    ...r,
    permissions: perms.filter((p) => p.roleId === r.id).map((p) => p.code).sort(),
    memberCount: members.find((m) => m.roleId === r.id)?.n ?? 0,
  }));
}

/** Id và tên của các vai trò thấy được trong `ids`, kèm quyền (id không thấy thì không có trong kết quả). */
export async function rolesWithPermissionRows(ids: readonly string[]) {
  if (ids.length === 0) return [];
  const db = getDb();
  const rows = await db
    .select({ id: roles.id, name: roles.name })
    .from(roles)
    .where(inArray(roles.id, [...ids]));
  if (rows.length === 0) return [];
  const perms = await db
    .select({ roleId: rolePermissions.roleId, code: rolePermissions.permissionCode })
    .from(rolePermissions)
    .where(inArray(rolePermissions.roleId, rows.map((r) => r.id)));
  return rows.map((r) => ({
    ...r,
    permissions: perms.filter((p) => p.roleId === r.id).map((p) => p.code).sort(),
  }));
}

/** Cặp (membership, vai trò) của các membership. */
export async function memberRoleRows(membershipIds: readonly string[]) {
  if (membershipIds.length === 0) return [];
  return getDb()
    .select({ membershipId: memberRoles.membershipId, roleId: memberRoles.roleId })
    .from(memberRoles)
    .where(inArray(memberRoles.membershipId, [...membershipIds]));
}

export async function membershipIdsWithRole(roleId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ membershipId: memberRoles.membershipId })
    .from(memberRoles)
    .where(eq(memberRoles.roleId, roleId));
  return rows.map((r) => r.membershipId);
}

/** Xoá mọi vai trò của membership rồi gán `roleIds`, trong giao dịch của bên gọi. */
export async function replaceMemberRoleRows(membershipId: string, companyId: string, roleIds: readonly string[]): Promise<void> {
  const db = getDb();
  await db.delete(memberRoles).where(eq(memberRoles.membershipId, membershipId));
  if (roleIds.length > 0) await db.insert(memberRoles).values(roleIds.map((roleId) => ({ membershipId, roleId, companyId })));
}

/** Có vai trò khác (có sẵn hoặc của công ty) cùng tên, không phân biệt hoa thường như index `roles_company_lower_name_uq`. */
export async function roleNameExists(name: string, exceptId?: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: roles.id })
    .from(roles)
    .where(and(sql`lower(${roles.name}) = lower(${name})`, exceptId ? ne(roles.id, exceptId) : undefined))
    .limit(1);
  return rows.length > 0;
}

export async function insertRole(companyId: string, name: string): Promise<string> {
  const [row] = await getDb().insert(roles).values({ companyId, name, kind: 'custom' }).returning({ id: roles.id });
  return row!.id;
}

export async function insertRolePermissions(roleId: string, codes: readonly string[]): Promise<void> {
  if (codes.length > 0) await getDb().insert(rolePermissions).values(codes.map((permissionCode) => ({ roleId, permissionCode })));
}

/** Thay toàn bộ quyền của một vai trò tuỳ biến (bên gọi đã kiểm vai trò thuộc công ty). */
export async function replaceRolePermissions(roleId: string, codes: readonly string[]): Promise<void> {
  await getDb().delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
  await insertRolePermissions(roleId, codes);
}

/** Đổi tên và tăng version nếu version khớp; trả false khi version đã đổi. */
export async function updateRoleIfVersion(id: string, version: number, name: string): Promise<boolean> {
  const rows = await getDb()
    .update(roles)
    .set({ name, version: sql`${roles.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(roles.id, id), eq(roles.version, version)))
    .returning({ id: roles.id });
  return rows.length > 0;
}

/** Xoá nếu version khớp (quyền xoá theo cascade); trả false khi version đã đổi. */
export async function deleteRoleIfVersion(id: string, version: number): Promise<boolean> {
  const rows = await getDb()
    .delete(roles)
    .where(and(eq(roles.id, id), eq(roles.version, version)))
    .returning({ id: roles.id });
  return rows.length > 0;
}
