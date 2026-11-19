// Luật đổi nhân viên (#7 [B]) và gán vai trò khi tạo link mời, duyệt (#7 [C]). Thuần, không I/O.
// Documents/21 I5: không gán CEO qua màn này; không thêm hay gỡ vai trò có quyền mình không có, trừ vai có sẵn Sale,
// Nhân viên kho (đổi 17/11/2026, #351).
import { BUILTIN_ROLES, type RoleWithPermissions } from '../../access/index.ts';

export type RoleCheck = 'ok' | 'unknown_roles' | 'ceo_role' | 'not_held';

/**
 * Kiểm theo thứ tự `unknown_roles` (id không có trong `found`: không tồn tại hoặc của công ty khác) → `ceo_role`
 * → `not_held`. `not_held` tính trên quyền của vai trò được thêm và bị gỡ so với `currentRoles`, so với quyền thô
 * của người gọi; vai trò giữ nguyên và vai `freelyAssignable` (Sale, Nhân viên kho có sẵn) không tính. Tạo link và duyệt gọi với `currentRoles: []`.
 */
export function checkRoleGrant(input: {
  requestedIds: readonly string[];
  found: readonly RoleWithPermissions[];
  currentRoles: readonly RoleWithPermissions[];
  callerPermissions: readonly string[];
}): RoleCheck {
  const requested = new Set(input.requestedIds);
  const byId = new Map(input.found.map((r) => [r.id, r]));
  if ([...requested].some((id) => !byId.has(id))) return 'unknown_roles';
  const requestedRoles = [...requested].map((id) => byId.get(id)!);
  if (requestedRoles.some((r) => r.isCeo)) return 'ceo_role';
  const current = new Set(input.currentRoles.map((r) => r.id));
  const changed = [
    ...requestedRoles.filter((r) => !current.has(r.id)),
    ...input.currentRoles.filter((r) => !requested.has(r.id)),
  ];
  const held = new Set(input.callerPermissions);
  return changed.some((r) => !r.freelyAssignable && r.permissions.some((p) => !held.has(p))) ? 'not_held' : 'ok';
}

/** Không đổi vai trò, khoá, mở khoá chính mình hay người mang vai trò CEO. */
export function isProtectedTarget(input: {
  callerId: string;
  targetId: string;
  targetRoles: readonly RoleWithPermissions[];
}): boolean {
  return input.callerId === input.targetId || input.targetRoles.some((r) => r.isCeo);
}

/**
 * Việc chỉ CEO làm (Documents/21 I5, đổi 19/11/2026): mời (tạo link, duyệt) người vai Admin, gán hay gỡ vai Admin,
 * khoá, mở khoá, đổi vai người đang có vai Admin. Admin và CEO ngang quyền ở mọi việc khác.
 */
export function touchesAdmin(input: { requestedIds?: readonly string[]; currentRoles?: readonly { id: string }[] }): boolean {
  const admin = BUILTIN_ROLES.admin.id;
  return (input.requestedIds ?? []).includes(admin) || (input.currentRoles ?? []).some((r) => r.id === admin);
}
