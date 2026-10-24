// Lời mời phía Admin (#7 [C], UC-PI-05): tạo link, hàng đợi, duyệt, từ chối. Thứ tự lỗi theo spec 6.5; luồng ghi
// theo spec 6.7 "Tạo link", "Approve", "Reject". Mã lỗi theo Documents/21 mục 3.1.
import { randomUUID } from 'node:crypto';
import { signPurposeToken } from '../../../shared/auth/purpose-token.ts';
import { env } from '../../../shared/config/env.ts';
import { withCompany } from '../../../shared/db/client.ts';
import { pgError } from '../../../shared/db/pg-error.ts';
import { AppError } from '../../../shared/errors/app-error.ts';
import { logger } from '../../../shared/logger.ts';
import { isUuid } from '../../../shared/uuid.ts';
import { findRolesWithPermissions, replaceMemberRoles, type RoleWithPermissions } from '../../access/index.ts';
import { recordAudit } from '../../audit/index.ts';
import { type InvitationStatus, isLinkExpired } from '../domain/invitation-machine.ts';
import { checkRoleGrant } from '../domain/member-rules.ts';
import {
  findAccountByEmail,
  findAccountSummaries,
  findMemberByAccount,
  insertAccount,
  insertMembership,
} from '../repository/accounts.ts';
import {
  decideInvitation,
  findInvitation,
  type InvitationRow,
  insertInvitation,
  listInvitationRows,
} from '../repository/invitations.ts';
import {
  type Caller,
  invalidRoles,
  notHeld,
  type Page,
  protectedAccount,
  type StaffMember,
  staffMemberOf,
} from './members.ts';
import { countTransition } from './metrics.ts';
import { openTotpSecret, sealTotpSecret } from './totp-secrets.ts';

/** Documents/21 mục 3.1 `Invitation`. */
export interface InvitationView {
  id: string;
  status: InvitationStatus;
  /** Suy ra từ `expiresAt` khi `open`, `claimed`. */
  expired: boolean;
  email: string | null;
  fullName: string | null;
  roles: { id: string; name: string }[];
  /** Có vai trò đã bị xoá sau khi tạo link. */
  outdated: boolean;
  /** Email đã có tài khoản lúc nộp; không lộ công ty nào. */
  existingAccount: boolean;
  createdBy: { id: string; fullName: string };
  createdAt: string;
  expiresAt: string;
  submittedAt: string | null;
  decidedAt: string | null;
  version: number;
}

const ENTITY = 'staff.invitations';

const notFound = () => new AppError(404, 'not_found', 'Không tìm thấy lời mời');
const outdated = () =>
  new AppError(409, 'invitation_outdated', 'Có vai trò của lời mời đã bị xoá: từ chối rồi tạo link mới');
const alreadyMember = () => new AppError(409, 'already_member', 'Người này đã là nhân viên của công ty');
const emailTaken = () => new AppError(409, 'email_taken', 'Email này đã có tài khoản');
const conflict = (current: InvitationView) =>
  new AppError(409, 'version_conflict', 'Lời mời vừa được người khác cập nhật', { current });

/** Gốc FE của link mời; máy dev chưa đặt `PUBLIC_WEB_URL` thì là Vite mặc định. */
const webBase = () => (env.PUBLIC_WEB_URL ?? 'http://localhost:5173').replace(/\/+$/, '');

async function views(rows: readonly InvitationRow[]): Promise<InvitationView[]> {
  if (rows.length === 0) return [];
  const roles = new Map(
    (await findRolesWithPermissions(rows.flatMap((r) => r.roleIds))).map((r): [string, RoleWithPermissions] => [
      r.id,
      r,
    ]),
  );
  const accounts = new Map(
    (await findAccountSummaries(rows.flatMap((r) => (r.accountId ? [r.createdBy, r.accountId] : [r.createdBy])))).map(
      (a) => [a.id, a],
    ),
  );
  const now = new Date();
  return rows.map((r) => {
    const found = r.roleIds.flatMap((id) => roles.get(id) ?? []);
    const account = r.accountId ? accounts.get(r.accountId) : undefined;
    return {
      id: r.id,
      status: r.status,
      expired: isLinkExpired(r, now),
      // Còn `open` thì email, họ tên chưa qua OTP (người cầm link tự gõ): không đưa cho Admin (Documents/21 mục 3.1).
      email: r.status === 'open' ? null : r.email,
      fullName: r.status === 'open' ? null : r.fullName,
      roles: found.map((role) => ({ id: role.id, name: role.name })).sort((x, y) => x.name.localeCompare(y.name, 'vi')),
      outdated: found.length < new Set(r.roleIds).size,
      // Tài khoản tạo lúc duyệt (email mới) sinh sau lúc nộp; tài khoản đã có thì có trước.
      existingAccount: !!account && account.createdAt < (r.submittedAt ?? now),
      createdBy: { id: r.createdBy, fullName: accounts.get(r.createdBy)?.fullName ?? '' },
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      submittedAt: r.submittedAt?.toISOString() ?? null,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      version: r.version,
    };
  });
}

const viewOf = async (row: InvitationRow) => (await views([row]))[0]!;

/** Khoá dòng trước mọi bước (thứ tự khoá: lời mời → tài khoản → membership → vai trò). */
async function lockPending(id: string, version: number): Promise<InvitationRow> {
  // `id` sai dạng coi như không có (V6).
  const row = isUuid(id) ? await findInvitation(id, { forUpdate: true }) : undefined;
  if (!row) throw notFound();
  // Lệch version hay đã quyết định ở phiên khác: cùng 409, kèm bản mới nhất.
  if (row.status !== 'pending' || row.version !== version) throw conflict(await viewOf(row));
  return row;
}

function assertGrant(caller: Caller, requestedIds: readonly string[], found: readonly RoleWithPermissions[]) {
  const check = checkRoleGrant({ requestedIds, found, currentRoles: [], callerPermissions: caller.permissions });
  if (check === 'unknown_roles') throw invalidRoles();
  if (check === 'ceo_role') throw protectedAccount();
  if (check === 'not_held') throw notHeld();
}

/**
 * Email mới: tạo tài khoản bằng mật khẩu người được mời đã đặt. [D] 2FA đã xác nhận lúc tham gia thì tài khoản có 2FA
 * bật sẵn: secret giải mã bằng AAD của lời mời, mã hoá lại bằng AAD của tài khoản (id sinh trước), chép mã khôi phục.
 */
async function createInvitedAccount(row: InvitationRow): Promise<string> {
  const id = randomUUID();
  const totp =
    row.totpConfirmedAt && row.totpSecretEnc
      ? {
          secretEnc: sealTotpSecret(openTotpSecret(row.totpSecretEnc, row.id), id),
          recoveryCodeHashes: row.recoveryCodeHashes,
        }
      : undefined;
  return insertAccount({
    id,
    email: row.email!,
    fullName: row.fullName!,
    passwordHash: row.passwordHash!,
    ...(totp ? { totp } : {}),
  });
}

/** Link chỉ trả lần này; DB giữ `id` (= `jti`), không giữ token. */
export async function createInvitation(
  caller: Caller,
  roleIds: string[],
): Promise<{ id: string; link: string; expiresAt: string }> {
  const row = await withCompany(caller.companyId, async () => {
    assertGrant(caller, roleIds, await findRolesWithPermissions(roleIds));
    const created = await insertInvitation({ companyId: caller.companyId, roleIds, createdBy: caller.accountId });
    await recordAudit({
      companyId: caller.companyId,
      actorId: caller.accountId,
      action: 'create',
      entityType: ENTITY,
      entityId: created.id,
      after: { roles: [...roleIds].sort() },
    });
    return created;
  });
  countTransition('open');
  logger.info({ invitationId: row.id, actorId: caller.accountId }, 'đã tạo link mời');
  const token = await signPurposeToken('invite', { jti: row.id, cid: caller.companyId });
  return { id: row.id, link: `${webBase()}/tham-gia#${token}`, expiresAt: row.expiresAt.toISOString() };
}

export async function listInvitations(
  companyId: string,
  query: { status: InvitationStatus; page: number; pageSize: number },
): Promise<Page<InvitationView>> {
  return withCompany(companyId, async () => {
    const { rows, total } = await listInvitationRows(query);
    return { items: await views(rows), total, page: query.page, pageSize: query.pageSize };
  });
}

/**
 * Duyệt: kiểm lại vai trò theo quyền người duyệt, tạo tài khoản (email mới) hoặc dùng tài khoản đã có, thêm membership
 * và vai trò, chuyển lời mời sang `approved`, xoá mật khẩu băm. Hết hạn link không chặn (Review Focus 4).
 */
export async function approveInvitation(
  caller: Caller,
  id: string,
  version: number,
): Promise<{ invitation: InvitationView; member: StaffMember }> {
  const result = await withCompany(caller.companyId, async () => {
    const row = await lockPending(id, version);
    const found = await findRolesWithPermissions(row.roleIds);
    if (found.length < new Set(row.roleIds).size) throw outdated();
    assertGrant(caller, row.roleIds, found);
    const existing = row.accountId ?? (await findAccountByEmail(row.email!))?.id;
    if (existing && (await findMemberByAccount(existing))) throw alreadyMember();
    // Email mới mà lúc duyệt đã có tài khoản (đăng ký bằng đường khác, hay lời mời ở công ty khác vừa được duyệt).
    if (!row.accountId && existing) throw emailTaken();
    const accountId = row.accountId ?? (await createInvitedAccount(row));
    const membershipId = await insertMembership(caller.companyId, accountId);
    await replaceMemberRoles(membershipId, caller.companyId, row.roleIds);
    const decided = await decideInvitation(row.id, version, {
      status: 'approved',
      decidedBy: caller.accountId,
      accountId,
    });
    // Đã giữ khoá dòng từ đầu nên câu ghi có điều kiện luôn trúng.
    if (!decided) throw new Error(`approveInvitation: không ghi được lời mời ${row.id}`);
    await recordAudit({
      companyId: caller.companyId,
      actorId: caller.accountId,
      action: 'create',
      entityType: 'staff.memberships',
      entityId: membershipId,
      after: { invitationId: row.id, roles: [...new Set(row.roleIds)].sort() },
    });
    logger.info({ invitationId: row.id, membershipId, actorId: caller.accountId }, 'đã duyệt lời mời');
    return { invitation: await viewOf(decided), member: await staffMemberOf(accountId) };
  }).catch((err: unknown) => {
    // Lưới cuối cho phiên chạy song song: tài khoản cùng email vừa được tạo, hay vai trò vừa bị xoá.
    const { code, constraint } = pgError(err);
    if (code === '23505' && constraint === 'accounts_email_unique') throw emailTaken();
    if (code === '23505' && constraint === 'memberships_company_id_account_id_unique') throw alreadyMember();
    if (
      code === '23503' &&
      (constraint === 'member_roles_role_id_roles_id_fk' || constraint === 'member_roles_company_fk')
    ) {
      throw outdated();
    }
    throw err;
  });
  countTransition('approved');
  return result;
}

export async function rejectInvitation(
  caller: Caller,
  id: string,
  version: number,
): Promise<{ invitation: InvitationView }> {
  const result = await withCompany(caller.companyId, async () => {
    const row = await lockPending(id, version);
    const decided = await decideInvitation(row.id, version, { status: 'rejected', decidedBy: caller.accountId });
    if (!decided) throw new Error(`rejectInvitation: không ghi được lời mời ${row.id}`);
    await recordAudit({
      companyId: caller.companyId,
      actorId: caller.accountId,
      action: 'update',
      entityType: ENTITY,
      entityId: row.id,
      before: { status: 'pending' },
      after: { status: 'rejected' },
    });
    logger.info({ invitationId: row.id, actorId: caller.accountId }, 'đã từ chối lời mời');
    return { invitation: await viewOf(decided) };
  });
  countTransition('rejected');
  return result;
}
