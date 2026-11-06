import {
  type AccessLoader,
  assertCompanyAccess,
  assertTokenCurrent,
  type CompanyAccess,
} from '../../../../shared/auth/company-access.ts';
import { type AccessClaims, signAccessToken } from '../../../../shared/auth/jwt.ts';
import { env } from '../../../../shared/config/env.ts';
import { inTransaction, withCompany } from '../../../../shared/db/client.ts';
import { pgError } from '../../../../shared/db/pg-error.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { BUILTIN_ROLES, assignRole, permissionModule, rolesAndPermissions } from '../../access/index.ts';
import { recordAudit } from '../../audit/index.ts';
import { createCompany, getCompanies, getEnabledModules, type OptionalModule } from '../../platform/index.ts';
import {
  type AccountRow,
  canSelfApprove,
  createAccount,
  createMembership,
  findAccountByEmail,
  findAccountById,
  findMembership,
  updatePassword,
} from '../../staff/index.ts';
import {
  findActiveRefreshToken,
  lockUsableRefreshToken,
  markRefreshTokenRotated,
  revokeAllRefreshTokens,
  revokeRefreshFamily,
  setRefreshTokenCompany,
} from '../repository/refresh-tokens.ts';
import { countLogin } from './metrics.ts';
import { hashPassword, verifyPassword } from './passwords.ts';
import {
  type CompanyContext,
  claimsFor,
  hashToken,
  type LoginResult,
  membershipViews,
  newRefreshToken,
  startSession,
  toAccountView,
} from './session.ts';

export {
  type AccountView,
  type CompanyContext,
  type LoginResult,
  type MembershipView,
  REFRESH_TOKEN_TTL_DAYS,
} from './session.ts';

/** Refresh token gốc chỉ đi ra cookie; DB giữ bản băm. */
export interface Session {
  accessToken: string;
  refreshToken: string;
}

const invalidCredentials = () => new AppError(401, 'invalid_credentials', 'Email hoặc mật khẩu không đúng');
const REFRESH_EXPIRED = 'Phiên đăng nhập đã hết hạn, hãy đăng nhập lại';
const invalidRefresh = () => new AppError(401, 'unauthorized', REFRESH_EXPIRED);

/**
 * 401 do cookie gửi lên là token đã xoay vòng (dùng lại quá hạn). Trình duyệt có thể đang giữ cookie mới hơn,
 * nên route không xoá cookie; cả họ token đã bị thu hồi nên cookie đó cũng không dùng được nữa.
 */
export class StaleRefreshTokenError extends AppError {
  constructor() {
    super(401, 'unauthorized', REFRESH_EXPIRED);
  }
}

/**
 * Trạng thái tài khoản trong công ty, đọc thẳng DB; `null` khi không thuộc công ty. Không ném lỗi.
 * `authorize` gọi ở mỗi request (qua `src/wiring.ts`): quyền thô, chưa lọc theo phân hệ.
 */
async function readCompanyAccess(
  accountId: string,
  companyId: string,
): Promise<(CompanyAccess & { companyName: string; roles: string[] }) | null> {
  const [membership, companies] = await Promise.all([findMembership(accountId, companyId), getCompanies([companyId])]);
  const company = companies.get(companyId);
  if (!membership || !company) return null;
  const [enabledModules, access] = await Promise.all([
    getEnabledModules(companyId),
    rolesAndPermissions([membership.id]),
  ]);
  const { roles, permissions } = access.get(membership.id) ?? { roles: [], permissions: [] };
  return {
    companyStatus: company.status,
    membershipStatus: membership.status,
    permissions,
    enabledModules,
    passwordChangedAt: membership.passwordChangedAt,
    companyName: company.name,
    roles,
  };
}

export const loadCompanyAccess: AccessLoader = readCompanyAccess;

/**
 * Kiểm membership còn dùng được rồi dựng ngữ cảnh công ty. Không thuộc công ty trả 404 như bản ghi
 * của công ty khác (Documents/21 C4); công ty khoá 403 `company_locked`; tài khoản khoá 403 `account_locked`.
 */
async function companyContext(accountId: string, companyId: string): Promise<CompanyContext> {
  const access = await readCompanyAccess(accountId, companyId);
  // Không so dấu token ở đây: `refresh` không có access token; `selectCompany` đã so qua `callerAccount`.
  assertCompanyAccess(access, null);
  const enabled = new Set<string>(access.enabledModules);
  return {
    companyId,
    companyName: access.companyName,
    roles: access.roles,
    // Quyền của phân hệ chưa bật không có hiệu lực (Documents/21 mục 8).
    permissions: access.permissions.filter((p) => enabled.has(permissionModule(p))),
    enabledModules: [...access.enabledModules],
    canSelfApprove: await withCompany(companyId, () => canSelfApprove(accountId)),
  };
}

/** Tài khoản của người gọi chỉ dùng access token; token phát trước lần đổi mật khẩu gần nhất thì 401 (#62). */
async function callerAccount(auth: AccessClaims): Promise<AccountRow> {
  const account = await findAccountById(auth.accountId);
  if (!account) throw invalidRefresh();
  assertTokenCurrent(auth, account.passwordChangedAt);
  return account;
}

export interface RegisterInput {
  company: { name: string; taxCode: string };
  ceo: { fullName: string; email: string; password: string };
  optionalModules: OptionalModule[];
  assistantDataConsent: boolean;
}

/** UC-PI-01: công ty, tài khoản CEO, phân hệ, nhật ký trong một transaction (Documents/21 V13). */
export async function register(input: RegisterInput): Promise<{ companyId: string; email: string }> {
  // Băm trước khi mở transaction: argon2 chậm có chủ ý, không nên giữ transaction trong lúc đó.
  const passwordHash = await hashPassword(input.ceo.password);
  const emailTaken = () =>
    new AppError(409, 'email_taken', 'Email đã được dùng', { errors: { 'ceo.email': 'Email này đã có tài khoản' } });
  try {
    return await inTransaction(async () => {
      if (await findAccountByEmail(input.ceo.email)) throw emailTaken();
      const accountId = await createAccount({ email: input.ceo.email, fullName: input.ceo.fullName, passwordHash });
      const companyId = await createCompany({
        ...input.company,
        optionalModules: input.optionalModules,
        aiConsent: input.assistantDataConsent,
        createdBy: accountId,
      });
      const membershipId = await createMembership(companyId, accountId);
      await assignRole({ membershipId, roleId: BUILTIN_ROLES.ceo.id, companyId });
      await recordAudit({
        companyId: null,
        actorId: accountId,
        action: 'create',
        entityType: 'core.companies',
        entityId: companyId,
        after: { ...input.company, ceoEmail: input.ceo.email, optionalModules: input.optionalModules },
      });
      return { companyId, email: input.ceo.email };
    });
  } catch (err) {
    // Hai người đăng ký cùng email cùng lúc: ràng buộc UNIQUE chặn người sau (#51).
    const { code, constraint } = pgError(err);
    if (code === '23505' && constraint === 'accounts_email_unique') throw emailTaken();
    throw err;
  }
}

/** UC-PI-03: đăng nhập chưa gắn công ty; sai email hay sai mật khẩu đều cùng một lỗi (Documents/21 V2). */
export async function login(input: { email: string; password: string }): Promise<LoginResult> {
  const account = await findAccountByEmail(input.email);
  const ok = await verifyPassword(account?.passwordHash, input.password);
  if (!account || !ok) {
    countLogin('password', 'invalid');
    throw invalidCredentials();
  }
  const session = await startSession(account);
  countLogin('password', 'ok');
  return session;
}

export async function me(auth: AccessClaims) {
  const account = await callerAccount(auth);
  return {
    account: toAccountView(account),
    memberships: account.isPlatformAdmin ? [] : await membershipViews(account.id),
  };
}

/** Cấp access token gắn công ty; phiên refresh hiện tại (nếu có) nhớ công ty để tải lại trang vẫn giữ. */
export async function selectCompany(auth: AccessClaims, companyId: string, refreshToken: string | undefined) {
  const account = await callerAccount(auth);
  const context = await companyContext(account.id, companyId);
  if (refreshToken) {
    const row = await findActiveRefreshToken(hashToken(refreshToken));
    if (row && row.accountId === account.id) await setRefreshTokenCompany(row.id, companyId);
  }
  return { accessToken: await signAccessToken(claimsFor(account, context)), context };
}

/**
 * Đổi refresh token lấy cặp token mới (xoay vòng, RFC 9700 §4.14.2). Token vừa bị xoay vòng trong
 * `REFRESH_REUSE_GRACE_SECONDS` vẫn đổi được, ra token mới cùng họ (F5 hai lần, nhiều tab refresh cùng lúc);
 * quá hạn đó là dùng lại token cũ: thu hồi cả họ, ghi nhật ký, 401. Công ty của phiên không còn dùng được
 * thì token mới không gắn công ty, FE đưa người dùng về trang chọn công ty.
 */
export async function refresh(refreshToken: string | undefined): Promise<Session> {
  if (!refreshToken) throw invalidRefresh();
  const graceMs = env.REFRESH_REUSE_GRACE_SECONDS * 1000;
  // Khoá dòng: hai refresh cùng cookie xếp hàng, request sau thấy mốc xoay vòng của request trước.
  const outcome = await inTransaction(async () => {
    const row = await lockUsableRefreshToken(hashToken(refreshToken));
    if (!row) return { kind: 'invalid' } as const;
    if (!row.rotatedAt) {
      await markRefreshTokenRotated(row.id);
      return { kind: 'ok', row } as const;
    }
    // Không dời mốc xoay vòng: hạn dùng lại tính từ lần xoay đầu, không kéo dài mãi.
    if (Date.now() - row.rotatedAt.getTime() <= graceMs) return { kind: 'ok', row } as const;
    await revokeRefreshFamily(row.familyId);
    await recordAudit({
      companyId: null,
      actorId: row.accountId,
      action: 'update',
      entityType: 'core.refresh_tokens',
      entityId: row.id,
      after: { reason: 'refresh_token_reuse', familyId: row.familyId },
    });
    return { kind: 'reuse', row } as const;
  });
  if (outcome.kind === 'invalid') throw invalidRefresh();
  const { row } = outcome;
  if (outcome.kind === 'reuse') {
    logger.warn({ accountId: row.accountId, familyId: row.familyId }, 'dùng lại refresh token đã xoay vòng, thu hồi cả họ');
    throw new StaleRefreshTokenError();
  }
  // Tạo token mới ngoài transaction (companyContext mở withCompany riêng); lỗi giữa chừng thì token cũ
  // vẫn còn trong hạn dùng lại nên gọi lại được.
  const account = await findAccountById(row.accountId);
  if (!account) throw invalidRefresh();
  let context: CompanyContext | null = null;
  if (row.companyId && !account.mustChangePassword) {
    context = await companyContext(account.id, row.companyId).catch(() => null);
  }
  return {
    accessToken: await signAccessToken(claimsFor(account, context)),
    refreshToken: await newRefreshToken(account.id, context?.companyId ?? null, row.familyId),
  };
}

/** Thu hồi cả họ token của cookie (kể cả cookie cũ còn trong hạn dùng lại): không token nào của phiên refresh được nữa. */
export async function logout(refreshToken: string | undefined): Promise<void> {
  if (!refreshToken) return;
  await inTransaction(async () => {
    const row = await lockUsableRefreshToken(hashToken(refreshToken));
    if (row) await revokeRefreshFamily(row.familyId);
  });
}

/**
 * UC-PI-04. Nhật ký cấp tài khoản, `company_id` trống (Documents/21 V12). Đổi xong thì mọi phiên refresh
 * của tài khoản bị thu hồi, kể cả phiên đang gọi; trả refresh token mới cho người vừa đổi (giữ công ty của phiên).
 */
export async function changePassword(
  auth: AccessClaims,
  input: { currentPassword: string; newPassword: string },
  refreshToken: string | undefined,
): Promise<string> {
  // Kiểm token trước argon2: token đã chết thì 401, không tốn băm, không ra 422.
  const account = await callerAccount(auth);
  const fieldError = (field: string, message: string) =>
    new AppError(422, 'validation_failed', 'Dữ liệu gửi lên không hợp lệ', { errors: { [field]: message } });
  if (!(await verifyPassword(account.passwordHash, input.currentPassword))) {
    throw fieldError('currentPassword', 'Mật khẩu hiện tại không đúng');
  }
  if (input.newPassword === input.currentPassword) {
    throw fieldError('newPassword', 'Mật khẩu mới phải khác mật khẩu hiện tại');
  }
  const [passwordHash, session] = await Promise.all([
    hashPassword(input.newPassword),
    refreshToken ? findActiveRefreshToken(hashToken(refreshToken)) : undefined,
  ]);
  const companyId = session?.accountId === account.id ? session.companyId : null;
  return inTransaction(async () => {
    await updatePassword(account.id, passwordHash);
    await revokeAllRefreshTokens(account.id);
    const token = await newRefreshToken(account.id, companyId);
    await recordAudit({
      companyId: null,
      actorId: account.id,
      action: 'update',
      entityType: 'core.accounts',
      entityId: account.id,
      after: { passwordChanged: true },
    });
    return token;
  });
}
