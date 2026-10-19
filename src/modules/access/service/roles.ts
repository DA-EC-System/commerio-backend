// Vai trò tuỳ biến (UC-PI-06). Thứ tự kiểm theo plan #8 P4; mã lỗi theo Documents/21 I3, V4–V8, D2, D3.
import { z } from 'zod';
import { withCompany } from '../../../shared/db/client.ts';
import { pgError } from '../../../shared/db/pg-error.ts';
import { AppError } from '../../../shared/errors/app-error.ts';
import { recordAudit } from '../../audit/index.ts';
import { getEnabledModules } from '../../platform/index.ts';
import { BUILTIN_ROLES } from '../domain/catalog.ts';
import { disabledCodes, grantableCatalog, lacking, mergeKeptPermissions } from '../domain/roles.ts';
import {
  deleteRoleIfVersion,
  findRoles,
  insertRole,
  insertRolePermissions,
  replaceRolePermissions,
  roleNameExists,
  updateRoleIfVersion,
} from '../repository/roles.ts';

/** Người gọi với quyền thô và phân hệ bật đọc từ DB ở request này (D1), không lấy từ token. */
export interface Caller {
  readonly accountId: string;
  readonly companyId: string;
  readonly permissions: readonly string[];
  readonly enabledModules: readonly string[];
}

export interface RoleInput {
  name: string;
  permissions: string[];
}

export interface RoleView {
  id: string;
  name: string;
  builtIn: boolean;
  permissions: string[];
  memberCount: number;
  version: number;
  updatedAt: string;
}

const BUILTIN_ORDER: readonly string[] = Object.values(BUILTIN_ROLES).map((r) => r.id);
const ENTITY = 'access.roles';

const notFound = () => new AppError(404, 'not_found', 'Không tìm thấy vai trò');
const builtinRole = () => new AppError(403, 'builtin_role', 'Vai trò có sẵn không sửa hay xoá được');
const notHeld = () => new AppError(403, 'permission_not_held', 'Chỉ cấp hay thao tác trên vai trò gồm những quyền bạn đang có');
const nameTaken = () =>
  new AppError(409, 'role_name_taken', 'Tên vai trò đã được dùng', { errors: { name: 'Tên vai trò đã được dùng trong công ty' } });
const moduleOff = () =>
  new AppError(422, 'validation_failed', 'Dữ liệu gửi lên không hợp lệ', {
    errors: { permissions: 'Có quyền thuộc phân hệ chưa bật' },
  });

type Found = Awaited<ReturnType<typeof findRoles>>[number];

function toView(r: Found): RoleView {
  return {
    id: r.id,
    name: r.name,
    builtIn: r.companyId === null,
    permissions: r.permissions,
    memberCount: r.memberCount,
    version: r.version,
    updatedAt: r.updatedAt.toISOString(),
  };
}

const snapshot = (r: { name: string; permissions: readonly string[] }) => ({ name: r.name, permissions: [...r.permissions] });

const pgCode = (err: unknown) => pgError(err).code;

/** Hai người cùng đặt một tên: unique index chặn người sau. */
function nameRace(err: unknown): never {
  throw pgCode(err) === '23505' ? nameTaken() : err;
}

async function findRole(id: string): Promise<Found> {
  // Mã không phải uuid thì PostgreSQL ném 22P02; coi như không tìm thấy (Documents/21 V6).
  if (!z.uuid().safeParse(id).success) throw notFound();
  const [role] = await findRoles(id);
  if (!role) throw notFound();
  if (role.companyId === null) throw builtinRole();
  return role;
}

const conflict = (current: Found) =>
  new AppError(409, 'version_conflict', `Vai trò "${current.name}" vừa được người khác sửa`, { current: toView(current) });

/** Ghi có điều kiện version không trúng dòng nào: người khác vừa sửa hoặc vừa xoá. */
async function lostRace(id: string): Promise<AppError> {
  const [current] = await findRoles(id);
  return current ? conflict(current) : notFound();
}

export async function listPermissions(companyId: string) {
  return grantableCatalog(await withCompany(companyId, () => getEnabledModules(companyId)));
}

/** Vai trò có sẵn theo thứ tự CEO, Admin, Sale, Nhân viên kho, rồi vai trò tuỳ biến theo tên. */
export async function listRoles(companyId: string): Promise<RoleView[]> {
  const rows = await withCompany(companyId, () => findRoles());
  const builtin = rows.filter((r) => r.companyId === null).sort((a, b) => BUILTIN_ORDER.indexOf(a.id) - BUILTIN_ORDER.indexOf(b.id));
  const custom = rows.filter((r) => r.companyId !== null).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  return [...builtin, ...custom].map(toView);
}

export async function createRole(caller: Caller, input: RoleInput): Promise<RoleView> {
  if (disabledCodes(input.permissions, caller.enabledModules).length > 0) throw moduleOff();
  const permissions = [...input.permissions].sort();
  return withCompany(caller.companyId, async () => {
    if (await roleNameExists(input.name)) throw nameTaken();
    if (lacking(permissions, caller.permissions).length > 0) throw notHeld();
    const id = await insertRole(caller.companyId, input.name);
    await insertRolePermissions(id, permissions);
    await recordAudit({
      companyId: caller.companyId,
      actorId: caller.accountId,
      action: 'create',
      entityType: ENTITY,
      entityId: id,
      after: snapshot({ name: input.name, permissions }),
    });
    const [created] = await findRoles(id);
    return toView(created!);
  }).catch(nameRace);
}

export async function updateRole(caller: Caller, id: string, input: RoleInput & { version: number }): Promise<RoleView> {
  return withCompany(caller.companyId, async () => {
    const role = await findRole(id);
    if (role.version !== input.version) throw conflict(role);
    if (lacking(role.permissions, caller.permissions).length > 0) throw notHeld();
    if (disabledCodes(input.permissions, caller.enabledModules).length > 0) throw moduleOff();
    if (await roleNameExists(input.name, id)) throw nameTaken();
    if (lacking(input.permissions, caller.permissions).length > 0) throw notHeld();
    const permissions = mergeKeptPermissions(input.permissions, role.permissions, caller.enabledModules);
    if (!(await updateRoleIfVersion(id, input.version, input.name))) throw await lostRace(id);
    await replaceRolePermissions(id, permissions);
    await recordAudit({
      companyId: caller.companyId,
      actorId: caller.accountId,
      action: 'update',
      entityType: ENTITY,
      entityId: id,
      before: snapshot(role),
      after: snapshot({ name: input.name, permissions }),
    });
    const [updated] = await findRoles(id);
    return toView(updated!);
  }).catch(nameRace);
}

export async function deleteRole(caller: Caller, id: string, version: number): Promise<void> {
  await withCompany(caller.companyId, async () => {
    const role = await findRole(id);
    if (role.version !== version) throw conflict(role);
    if (lacking(role.permissions, caller.permissions).length > 0) throw notHeld();
    if (role.memberCount > 0) {
      throw new AppError(409, 'role_in_use', `Còn ${role.memberCount} tài khoản đang mang vai trò "${role.name}"`);
    }
    if (!(await deleteRoleIfVersion(id, version))) throw await lostRace(id);
    await recordAudit({
      companyId: caller.companyId,
      actorId: caller.accountId,
      action: 'delete',
      entityType: ENTITY,
      entityId: id,
      before: snapshot(role),
    });
  }).catch((err: unknown) => {
    // Người khác vừa gán vai trò này cho tài khoản: khoá ngoại member_roles chặn xoá.
    if (pgCode(err) === '23503') throw new AppError(409, 'role_in_use', 'Vai trò đang được gán cho tài khoản');
    throw err;
  });
}
