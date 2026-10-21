// Dựng phiên sau bước xác thực, dùng chung cho `/login` (mật khẩu), `/google` (#7 [A]) và `/login/2fa` (#7 [D]):
// access token chưa gắn công ty, refresh token mới, tài khoản và các công ty.
import { createHash, randomBytes } from 'node:crypto';
import { type AccessClaims, signAccessToken } from '../../../shared/auth/jwt.ts';
import { signPurposeToken } from '../../../shared/auth/purpose-token.ts';
import { env } from '../../../shared/config/env.ts';
import { rolesAndPermissions } from '../../access/index.ts';
import { getCompanies } from '../../platform/index.ts';
import { type AccountRow, membershipsOfAccount } from '../../staff/index.ts';
import { insertRefreshToken } from '../repository/refresh-tokens.ts';

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

/** Phản hồi của `/login`, `/google`; refresh token gốc chỉ đi ra cookie. */
export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  account: AccountView;
  memberships: MembershipView[];
}

/** Tài khoản đã bật 2FA (khi `TWO_FACTOR_MODE=required`): chưa cấp phiên, gửi mã ở `/login/2fa` kèm `mfaToken`. */
export interface MfaChallenge {
  mfaRequired: true;
  /** Token `mfa` sống 5 phút, chỉ dùng cho `/login/2fa`. */
  mfaToken: string;
}

export const isMfaChallenge = (result: LoginResult | MfaChallenge): result is MfaChallenge => 'mfaRequired' in result;

const twoFactorRequired = () => env.TWO_FACTOR_MODE === 'required';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function toAccountView(a: AccountRow): AccountView {
  return {
    id: a.id,
    email: a.email,
    fullName: a.fullName,
    isPlatformAdmin: a.isPlatformAdmin,
    mustChangePassword: a.mustChangePassword,
  };
}

export async function newRefreshToken(accountId: string, companyId: string | null): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await insertRefreshToken({
    accountId,
    companyId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 3600 * 1000),
  });
  return token;
}

export async function membershipViews(accountId: string): Promise<MembershipView[]> {
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

export function claimsFor(account: AccountRow, context: CompanyContext | null): Omit<AccessClaims, 'expiresAt'> {
  return {
    accountId: account.id,
    companyId: context?.companyId ?? null,
    permissions: context?.permissions ?? [],
    mustChangePassword: account.mustChangePassword,
    passwordChangedAt: account.passwordChangedAt?.getTime() ?? null,
    // Refresh sau khi xác nhận 2FA đọc lại tài khoản nên token mới không còn cờ.
    twoFactorSetupRequired: twoFactorRequired() && account.totpEnabledAt === null,
  };
}

/** Phiên mới chưa gắn công ty cho tài khoản đã qua bước xác thực. Quản trị nền tảng không có công ty. */
export async function startSession(account: AccountRow): Promise<LoginResult> {
  return {
    accessToken: await signAccessToken(claimsFor(account, null)),
    refreshToken: await newRefreshToken(account.id, null),
    account: toAccountView(account),
    memberships: account.isPlatformAdmin ? [] : await membershipViews(account.id),
  };
}

/**
 * Sau bước xác thực thứ nhất (mật khẩu, Google): tài khoản đã bật 2FA thì đòi mã (`MfaChallenge`), chưa bật thì cấp
 * phiên mang cờ `tfs`. `TWO_FACTOR_MODE=off` thì cấp phiên như chưa có 2FA (AC-D11).
 */
export async function afterFirstFactor(account: AccountRow): Promise<LoginResult | MfaChallenge> {
  if (twoFactorRequired() && account.totpEnabledAt) {
    return { mfaRequired: true, mfaToken: await signPurposeToken('mfa', { sub: account.id }) };
  }
  return startSession(account);
}
