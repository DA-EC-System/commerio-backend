// Quản lý nhân viên trong công ty (UC-PI-05, #7 [B]): danh sách, đổi vai trò, khoá, mở khoá.
// Thứ tự kiểm theo spec #7 mục 6.5 [B]; mã lỗi theo Documents/21 I3, I5, C3, C4.
import { withCompany } from '../../../shared/db/client.ts';
import { pgError } from '../../../shared/db/pg-error.ts';
import { AppError } from '../../../shared/errors/app-error.ts';
import { logger } from '../../../shared/logger.ts';
import { isUuid } from '../../../shared/uuid.ts';
import {
  findRolesWithPermissions,
  memberRolesOf,
  membershipIdsWithRole,
  replaceMemberRoles,
  type RoleWithPermissions,
} from '../../access/index.ts';
import { recordAudit } from '../../audit/index.ts';
import { checkRoleGrant, isProtectedTarget } from '../domain/member-rules.ts';
import {
  bumpMembershipVersion,
  findMemberByAccount,
  listMembers,
  type MemberRow,
  type StaffQuery,
  updateMembershipStatus,
} from '../repository/accounts.ts';

/** Người gọi với quyền thô đọc từ DB ở request này (`getAccess`, Documents/21 D1), không lấy từ token. */
export interface Caller {
  readonly accountId: string;
  readonly companyId: string;
  readonly permissions: readonly string[];
}

export interface StaffMember {
  accountId: string;
  email: string;
  fullName: string;
  roles: { id: string; name: string }[];
  status: 'active' | 'locked';
  isCeo: boolean;
  /** Tài khoản còn phải đổi mật khẩu (`must_change_password`). */
  pendingFirstLogin: boolean;
  /** Của membership. */
  joinedAt: string;
  version: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

const ENTITY = 'staff.memberships';

const notFound = () => new AppError(404, 'not_found', 'Không tìm thấy nhân viên');
export const protectedAccount = () =>
  new AppError(403, 'protected_account', 'Không đổi vai trò, khoá hay mở khoá CEO hoặc chính mình, không gán vai trò CEO');
export const notHeld = () =>
  new AppError(403, 'permission_not_held', 'Chỉ thêm hay gỡ vai trò gồm những quyền bạn đang có');
export const invalidRoles = () =>
  new AppError(422, 'validation_failed', 'Dữ liệu gửi lên không hợp lệ', {
    errors: { roleIds: 'Có vai trò không tồn tại hoặc không thuộc công ty' },
  });

const apiStatus = (status: MemberRow['status']) => (status === 'suspended' ? 'locked' : 'active');

export function toStaffMember(row: MemberRow, roles: readonly RoleWithPermissions[]): StaffMember {
  return {
    accountId: row.accountId,
    email: row.email,
    fullName: row.fullName,
    roles: roles.map((r) => ({ id: r.id, name: r.name })),
    status: apiStatus(row.status),
    isCeo: roles.some((r) => r.isCeo),
    pendingFirstLogin: row.mustChangePassword,
    joinedAt: row.joinedAt.toISOString(),
    version: row.version,
  };
}

async function loadMember(accountId: string): Promise<{ row: MemberRow; roles: RoleWithPermissions[] }> {
  // `accountId` sai dạng coi như không có (Documents/21 V6).
  const row = isUuid(accountId) ? await findMemberByAccount(accountId) : undefined;
  if (!row) throw notFound();
  const roles = (await memberRolesOf([row.membershipId])).get(row.membershipId) ?? [];
  return { row, roles };
}

const conflict = (member: StaffMember) =>
  new AppError(409, 'version_conflict', `Nhân viên "${member.fullName}" vừa được người khác cập nhật`, { current: member });

/** Ghi có điều kiện không trúng dòng: người khác vừa sửa. Trả 409 kèm bản mới nhất. */
async function lostRace(accountId: string): Promise<AppError> {
  const { row, roles } = await loadMember(accountId);
  return conflict(toStaffMember(row, roles));
}

/** Đích là CEO hoặc chính mình: 403 trước mọi bước khác (sau 404). */
async function loadTarget(caller: Caller, accountId: string) {
  const target = await loadMember(accountId);
  if (isProtectedTarget({ callerId: caller.accountId, targetId: accountId, targetRoles: target.roles })) {
    throw protectedAccount();
  }
  return target;
}

export async function listStaff(companyId: string, query: StaffQuery & { roleId?: string }): Promise<Page<StaffMember>> {
  return withCompany(companyId, async () => {
    const membershipIds = query.roleId ? await membershipIdsWithRole(query.roleId) : undefined;
    const { rows, total } = await listMembers({ ...query, membershipIds });
    const roles = await memberRolesOf(rows.map((r) => r.membershipId));
    return {
      items: rows.map((r) => toStaffMember(r, roles.get(r.membershipId) ?? [])),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  });
}

export async function changeRoles(
  caller: Caller,
  accountId: string,
  input: { roleIds: string[]; version: number },
): Promise<StaffMember> {
  return withCompany(caller.companyId, async () => {
    const { row, roles: currentRoles } = await loadTarget(caller, accountId);
    if (row.version !== input.version) throw conflict(toStaffMember(row, currentRoles));
    const found = await findRolesWithPermissions(input.roleIds);
    const check = checkRoleGrant({
      requestedIds: input.roleIds,
      found,
      currentRoles,
      callerPermissions: caller.permissions,
    });
    if (check === 'unknown_roles') throw invalidRoles();
    if (check === 'ceo_role') throw protectedAccount();
    if (check === 'not_held') throw notHeld();
    if (!(await bumpMembershipVersion(row.membershipId, input.version))) throw await lostRace(accountId);
    await replaceMemberRoles(row.membershipId, caller.companyId, input.roleIds);
    const roleIds = [...new Set(input.roleIds)].sort();
    await recordAudit({
      companyId: caller.companyId,
      actorId: caller.accountId,
      action: 'update',
      entityType: ENTITY,
      entityId: row.membershipId,
      before: { roles: currentRoles.map((r) => r.id).sort() },
      after: { roles: roleIds },
    });
    logger.info({ membershipId: row.membershipId, actorId: caller.accountId }, 'đã đổi vai trò nhân viên');
    const updated = await loadMember(accountId);
    return toStaffMember(updated.row, updated.roles);
  }).catch((err: unknown) => {
    // Lưới cuối: vai trò không thuộc công ty lọt qua bước kiểm (trigger member_roles_company_fk, migration 0017).
    const { code, constraint } = pgError(err);
    if (code === '23503' && constraint === 'member_roles_company_fk') throw invalidRoles();
    throw err;
  });
}

/** Khoá có hiệu lực ngay với API vì `authorize` đọc trạng thái membership từ DB mỗi request (D1). */
export async function setLocked(caller: Caller, accountId: string, locked: boolean, version: number): Promise<StaffMember> {
  const from = locked ? 'active' : 'suspended';
  const to = locked ? 'suspended' : 'active';
  return withCompany(caller.companyId, async () => {
    const { row, roles } = await loadTarget(caller, accountId);
    // Lệch version hoặc đã ở trạng thái đích: cùng 409, kèm bản mới nhất.
    if (row.version !== version || row.status !== from) throw conflict(toStaffMember(row, roles));
    if (!(await updateMembershipStatus(row.membershipId, version, from, to))) throw await lostRace(accountId);
    await recordAudit({
      companyId: caller.companyId,
      actorId: caller.accountId,
      action: 'update',
      entityType: ENTITY,
      entityId: row.membershipId,
      before: { status: apiStatus(from) },
      after: { status: apiStatus(to) },
    });
    logger.info({ membershipId: row.membershipId, actorId: caller.accountId, status: apiStatus(to) }, 'đã đổi trạng thái nhân viên');
    const updated = await loadMember(accountId);
    return toStaffMember(updated.row, updated.roles);
  });
}
