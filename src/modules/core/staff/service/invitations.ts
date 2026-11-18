// Lời mời phía Admin (#7 [C], UC-PI-05): tạo link, hàng đợi, duyệt, từ chối. Thứ tự lỗi theo spec 6.5; luồng ghi
// theo spec 6.7 "Tạo link", "Approve", "Reject". Mã lỗi theo Documents/21 mục 3.1.
import { signPurposeToken } from '../../../../shared/auth/purpose-token.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { pgError } from '../../../../shared/db/pg-error.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { vnShortDateTime } from '../../../../shared/vn-format.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import { findRolesWithPermissions, replaceMemberRoles, type RoleWithPermissions } from '../../access/index.ts';
import { recordAudit } from '../../audit/index.ts';
import { publishEvent } from '../../platform/index.ts';
import { canTransition, type InvitationStatus, isLinkExpired } from '../domain/invitation-machine.ts';
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
  revokeInvitationRow,
} from '../repository/invitations.ts';
import {
  type Caller,
  invalidRoles,
  memberLabel,
  notHeld,
  type Page,
  protectedAccount,
  roleNames,
  type StaffMember,
  staffMemberOf,
} from './members.ts';
import { countTransition } from './metrics.ts';
import { joinLink } from './web-links.ts';

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

const ENTITY = 'core.invitations';

const notFound = () => new AppError(404, 'not_found', 'Không tìm thấy lời mời');
const outdated = () =>
  new AppError(409, 'invitation_outdated', 'Có vai trò của lời mời đã bị xoá: từ chối rồi tạo link mới');
const alreadyMember = () => new AppError(409, 'already_member', 'Người này đã là nhân viên của công ty');
const emailTaken = () => new AppError(409, 'email_taken', 'Email này đã có tài khoản');
const conflict = (current: InvitationView) =>
  new AppError(409, 'version_conflict', 'Lời mời vừa được người khác cập nhật', { current });

const STATUS_DETAIL: Record<InvitationStatus, string> = {
  open: 'Người được mời chưa nộp yêu cầu',
  claimed: 'Người được mời chưa nộp yêu cầu',
  pending: 'Người được mời đã nộp yêu cầu: duyệt hoặc từ chối ở tab Chờ duyệt',
  approved: 'Yêu cầu đã được duyệt',
  rejected: 'Yêu cầu đã bị từ chối',
  revoked: 'Link đã bị huỷ',
};
/** Trạng thái hiện tại không cho thao tác này (Documents/21 mục 14), kiểm trước version (#353). */
const invalidTransition = (current: InvitationView) =>
  new AppError(409, 'invalid_transition', STATUS_DETAIL[current.status], { current });

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

/** Nhãn nhật ký của lời mời: đã có email (qua OTP) thì nói người được mời, chưa có thì giờ tạo link (#352). */
function invitationLabel(view: Pick<InvitationView, 'roles' | 'email' | 'fullName' | 'createdAt'>): string {
  const roles = view.roles.length ? `vai ${roleNames(view.roles).join(', ')}` : '(vai đã xoá)';
  return view.email
    ? `Link mời ${roles} cho ${memberLabel({ fullName: view.fullName ?? '', email: view.email })}`
    : `Link mời ${roles} (tạo ${vnShortDateTime(new Date(view.createdAt))})`;
}

/**
 * Khoá dòng trước mọi bước (thứ tự khoá: lời mời → tài khoản → membership → vai trò), rồi kiểm lời mời còn chuyển
 * sang `to` được. Trạng thái trước version (#353): đã quyết định ở phiên khác thì báo trạng thái, không báo "vừa được
 * cập nhật".
 */
async function lockInvitation(id: string, version: number, to: InvitationStatus): Promise<InvitationRow> {
  // `id` sai dạng coi như không có (V6).
  const row = isUuid(id) ? await findInvitation(id, { forUpdate: true }) : undefined;
  if (!row) throw notFound();
  if (!canTransition(row.status, to)) throw invalidTransition(await viewOf(row));
  if (row.version !== version) throw conflict(await viewOf(row));
  return row;
}

function publishDecided(invitationId: string, decision: 'approved' | 'rejected') {
  return publishEvent({ type: 'staff.invitation_decided', aggregateId: invitationId, payload: { invitationId, decision } });
}

function assertGrant(caller: Caller, requestedIds: readonly string[], found: readonly RoleWithPermissions[]) {
  const check = checkRoleGrant({ requestedIds, found, currentRoles: [], callerPermissions: caller.permissions });
  if (check === 'unknown_roles') throw invalidRoles();
  if (check === 'ceo_role') throw protectedAccount();
  if (check === 'not_held') throw notHeld();
}

/** Link chỉ trả lần này; DB giữ `id` (= `jti`), không giữ token. */
export async function createInvitation(
  caller: Caller,
  roleIds: string[],
): Promise<{ id: string; link: string; expiresAt: string }> {
  const row = await withCompany(caller.companyId, async () => {
    const found = await findRolesWithPermissions(roleIds);
    assertGrant(caller, roleIds, found);
    const created = await insertInvitation({ companyId: caller.companyId, roleIds, createdBy: caller.accountId });
    await recordAudit({
      companyId: caller.companyId,
      actorId: caller.accountId,
      action: 'create',
      entityType: ENTITY,
      entityId: created.id,
      label: invitationLabel({ roles: found, email: null, fullName: null, createdAt: created.createdAt.toISOString() }),
      after: { roles: roleNames(found) },
    });
    return created;
  });
  countTransition('open');
  logger.info({ invitationId: row.id, actorId: caller.accountId }, 'đã tạo link mời');
  const token = await signPurposeToken('invite', { jti: row.id, cid: caller.companyId });
  return { id: row.id, link: joinLink(token), expiresAt: row.expiresAt.toISOString() };
}

export async function listInvitations(
  companyId: string,
  query: { status: InvitationStatus[]; page: number; pageSize: number },
): Promise<Page<InvitationView>> {
  return withCompany(companyId, async () => {
    const { rows, total } = await listInvitationRows({ statuses: query.status, page: query.page, pageSize: query.pageSize });
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
    const row = await lockInvitation(id, version, 'approved');
    const found = await findRolesWithPermissions(row.roleIds);
    if (found.length < new Set(row.roleIds).size) throw outdated();
    assertGrant(caller, row.roleIds, found);
    const existing = row.accountId ?? (await findAccountByEmail(row.email!))?.id;
    if (existing && (await findMemberByAccount(existing))) throw alreadyMember();
    // Email mới mà lúc duyệt đã có tài khoản (đăng ký bằng đường khác, hay lời mời ở công ty khác vừa được duyệt).
    if (!row.accountId && existing) throw emailTaken();
    const accountId =
      row.accountId ??
      (await insertAccount({ email: row.email!, fullName: row.fullName!, passwordHash: row.passwordHash! }));
    const membershipId = await insertMembership(caller.companyId, accountId);
    await replaceMemberRoles(membershipId, caller.companyId, row.roleIds);
    const decided = await decideInvitation(row.id, version, {
      status: 'approved',
      decidedBy: caller.accountId,
      accountId,
    });
    // Đã giữ khoá dòng từ đầu nên câu ghi có điều kiện luôn trúng.
    if (!decided) throw new Error(`approveInvitation: không ghi được lời mời ${row.id}`);
    const member = await staffMemberOf(accountId);
    await recordAudit({
      companyId: caller.companyId,
      actorId: caller.accountId,
      action: 'create',
      operation: 'join',
      entityType: 'core.memberships',
      entityId: membershipId,
      label: memberLabel(member),
      after: { fullName: member.fullName, email: member.email, roles: roleNames(member.roles) },
    });
    // Thư báo kết quả gửi qua outbox, cùng giao dịch: duyệt rollback thì không có thư.
    await publishDecided(row.id, 'approved');
    logger.info({ invitationId: row.id, membershipId, actorId: caller.accountId }, 'đã duyệt lời mời');
    return { invitation: await viewOf(decided), member };
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
    const row = await lockInvitation(id, version, 'rejected');
    const decided = await decideInvitation(row.id, version, { status: 'rejected', decidedBy: caller.accountId });
    if (!decided) throw new Error(`rejectInvitation: không ghi được lời mời ${row.id}`);
    const invitation = await viewOf(decided);
    await recordAudit({
      companyId: caller.companyId,
      actorId: caller.accountId,
      action: 'update',
      operation: 'reject',
      entityType: ENTITY,
      entityId: row.id,
      label: invitationLabel(invitation),
      before: { status: 'pending' },
      after: { status: 'rejected' },
    });
    await publishDecided(row.id, 'rejected');
    logger.info({ invitationId: row.id, actorId: caller.accountId }, 'đã từ chối lời mời');
    return { invitation };
  });
  countTransition('rejected');
  return result;
}

/**
 * Huỷ link chưa nộp (`open | claimed → revoked`, Documents/21 mục 3.1). Không còn `open`, `claimed`: 409
 * `invalid_transition`; lệch version: 409 `version_conflict`; cả hai kèm bản mới nhất. Link quá hạn vẫn huỷ được.
 */
export async function revokeInvitation(
  caller: Caller,
  id: string,
  version: number,
): Promise<{ invitation: InvitationView }> {
  const result = await withCompany(caller.companyId, async () => {
    const row = await lockInvitation(id, version, 'revoked');
    const revoked = await revokeInvitationRow(row.id, version, caller.accountId);
    // Đã giữ khoá dòng từ đầu nên câu ghi có điều kiện luôn trúng.
    if (!revoked) throw new Error(`revokeInvitation: không ghi được lời mời ${row.id}`);
    const invitation = await viewOf(revoked);
    await recordAudit({
      companyId: caller.companyId,
      actorId: caller.accountId,
      action: 'update',
      operation: 'revoke',
      entityType: ENTITY,
      entityId: row.id,
      // Huỷ lúc còn `open`: email, họ tên chưa qua OTP (người cầm link tự gõ), không ghi vào nhãn (Documents/21 mục 3.1).
      label: invitationLabel(row.status === 'open' ? { ...invitation, email: null, fullName: null } : invitation),
      before: { status: row.status },
      after: { status: 'revoked' },
    });
    logger.info({ invitationId: row.id, actorId: caller.accountId }, 'đã huỷ link mời');
    return { invitation };
  });
  countTransition('revoked');
  return result;
}
