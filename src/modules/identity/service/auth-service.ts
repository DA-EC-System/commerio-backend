import { createHash, randomBytes } from 'node:crypto';
import { type AccessLoader, assertCompanyAccess, type CompanyAccess } from '../../../shared/auth/company-access.ts';
import { type AccessClaims, signAccessToken } from '../../../shared/auth/jwt.ts';
import { inTransaction } from '../../../shared/db/client.ts';
import { AppError } from '../../../shared/errors/app-error.ts';
import { BUILTIN_ROLES, assignRole, permissionModule, rolesAndPermissions } from '../../access/index.ts';
import { recordAudit } from '../../audit/index.ts';
import { createCompany, getCompanies, getEnabledModules, type OptionalModule } from '../../platform/index.ts';
import {
  type AccountRow,
  createAccount,
  createMembership,
  findAccountByEmail,
  findAccountById,
  findMembership,
  membershipsOfAccount,
  updatePassword,
} from '../../staff/index.ts';
import {
  findActiveRefreshToken,
  insertRefreshToken,
  revokeRefreshToken,
  setRefreshTokenCompany,
} from '../repository/refresh-tokens.ts';
import { hashPassword, verifyPassword } from './passwords.ts';

export const REFRESH_TOKEN_TTL_DAYS = 30;

export interface AccountView {
  id: string;
  email: string;
  fullName: string;
  isPlatformAdmin: boolean;
  mustChangePassword: boolean;
}

export interface MembershipView {
  companyId: string;
  companyName: string;
  companyStatus: 'active' | 'locked';
  status: 'active' | 'locked';
  roles: string[];
}

export interface CompanyContext {
  companyId: string;
  companyName: string;
  roles: string[];
  permissions: string[];
  enabledModules: string[];
}

/** Refresh token gốc chỉ đi ra cookie; DB giữ bản băm. */
export interface Session {
  accessToken: string;
  refreshToken: string;
}

const invalidCredentials = () => new AppError(401, 'invalid_credentials', 'Email hoặc mật khẩu không đúng');
const invalidRefresh = () => new AppError(401, 'unauthorized', 'Phiên đăng nhập đã hết hạn, hãy đăng nhập lại');

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

function toAccountView(a: AccountRow): AccountView {
  return {
    id: a.id,
    email: a.email,
    fullName: a.fullName,
    isPlatformAdmin: a.isPlatformAdmin,
    mustChangePassword: a.mustChangePassword,
  };
}

async function newRefreshToken(accountId: string, companyId: string | null): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await insertRefreshToken({
    accountId,
    companyId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 3600 * 1000),
  });
  return token;
}

async function membershipViews(accountId: string): Promise<MembershipView[]> {
  const memberships = await membershipsOfAccount(accountId);
  const companies = await getCompanies(memberships.map((m) => m.companyId));
  const access = await rolesAndPermissions(memberships.map((m) => m.id));
  return memberships.flatMap((m) => {
    const company = companies.get(m.companyId);
    if (!company) return [];
    return [
      {
        companyId: company.id,
        companyName: company.name,
        companyStatus: company.status,
        status: m.status === 'suspended' ? 'locked' : 'active',
        roles: access.get(m.id)?.roles ?? [],
      },
    ];
  });
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
  assertCompanyAccess(access);
  const enabled = new Set<string>(access.enabledModules);
  return {
    companyId,
    companyName: access.companyName,
    roles: access.roles,
    // Quyền của phân hệ chưa bật không có hiệu lực (Documents/21 mục 8).
    permissions: access.permissions.filter((p) => enabled.has(permissionModule(p))),
    enabledModules: [...access.enabledModules],
  };
}

function claimsFor(account: AccountRow, context: CompanyContext | null): Omit<AccessClaims, 'expiresAt'> {
  return {
    accountId: account.id,
    companyId: context?.companyId ?? null,
    permissions: context?.permissions ?? [],
    mustChangePassword: account.mustChangePassword,
  };
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
        entityType: 'platform.companies',
        entityId: companyId,
        after: { ...input.company, ceoEmail: input.ceo.email, optionalModules: input.optionalModules },
      });
      return { companyId, email: input.ceo.email };
    });
  } catch (err) {
    // Hai người đăng ký cùng email cùng lúc: ràng buộc UNIQUE chặn người sau.
    if ((err as { code?: string }).code === '23505') throw emailTaken();
    throw err;
  }
}

/** UC-PI-03: đăng nhập chưa gắn công ty; sai email hay sai mật khẩu đều cùng một lỗi (Documents/21 V2). */
export async function login(input: { email: string; password: string }) {
  const account = await findAccountByEmail(input.email);
  const ok = await verifyPassword(account?.passwordHash, input.password);
  if (!account || !ok) throw invalidCredentials();
  return {
    accessToken: await signAccessToken(claimsFor(account, null)),
    refreshToken: await newRefreshToken(account.id, null),
    account: toAccountView(account),
    memberships: account.isPlatformAdmin ? [] : await membershipViews(account.id),
  };
}

export async function me(accountId: string) {
  const account = await findAccountById(accountId);
  if (!account) throw invalidRefresh();
  return {
    account: toAccountView(account),
    memberships: account.isPlatformAdmin ? [] : await membershipViews(account.id),
  };
}

/** Cấp access token gắn công ty; phiên refresh hiện tại (nếu có) nhớ công ty để tải lại trang vẫn giữ. */
export async function selectCompany(auth: AccessClaims, companyId: string, refreshToken: string | undefined) {
  const account = await findAccountById(auth.accountId);
  if (!account) throw invalidRefresh();
  const context = await companyContext(account.id, companyId);
  if (refreshToken) {
    const row = await findActiveRefreshToken(hashToken(refreshToken));
    if (row && row.accountId === account.id) await setRefreshTokenCompany(row.id, companyId);
  }
  return { accessToken: await signAccessToken(claimsFor(account, context)), context };
}

/**
 * Đổi refresh token cũ lấy cặp token mới (xoay vòng). Công ty của phiên không còn dùng được
 * thì token mới không gắn công ty, FE đưa người dùng về trang chọn công ty.
 */
export async function refresh(refreshToken: string | undefined): Promise<Session> {
  const row = refreshToken ? await findActiveRefreshToken(hashToken(refreshToken)) : undefined;
  if (!row || !(await revokeRefreshToken(row.id))) throw invalidRefresh();
  const account = await findAccountById(row.accountId);
  if (!account) throw invalidRefresh();
  let context: CompanyContext | null = null;
  if (row.companyId && !account.mustChangePassword) {
    context = await companyContext(account.id, row.companyId).catch(() => null);
  }
  return {
    accessToken: await signAccessToken(claimsFor(account, context)),
    refreshToken: await newRefreshToken(account.id, context?.companyId ?? null),
  };
}

export async function logout(refreshToken: string | undefined): Promise<void> {
  const row = refreshToken ? await findActiveRefreshToken(hashToken(refreshToken)) : undefined;
  if (row) await revokeRefreshToken(row.id);
}

/** UC-PI-04. Nhật ký cấp tài khoản, `company_id` trống (Documents/21 V12). */
export async function changePassword(accountId: string, input: { currentPassword: string; newPassword: string }) {
  const account = await findAccountById(accountId);
  if (!account) throw invalidRefresh();
  const fieldError = (field: string, message: string) =>
    new AppError(422, 'validation_failed', 'Dữ liệu gửi lên không hợp lệ', { errors: { [field]: message } });
  if (!(await verifyPassword(account.passwordHash, input.currentPassword))) {
    throw fieldError('currentPassword', 'Mật khẩu hiện tại không đúng');
  }
  if (input.newPassword === input.currentPassword) {
    throw fieldError('newPassword', 'Mật khẩu mới phải khác mật khẩu hiện tại');
  }
  const passwordHash = await hashPassword(input.newPassword);
  await inTransaction(async () => {
    await updatePassword(account.id, passwordHash);
    await recordAudit({
      companyId: null,
      actorId: account.id,
      action: 'update',
      entityType: 'staff.accounts',
      entityId: account.id,
      after: { passwordChanged: true },
    });
  });
}
