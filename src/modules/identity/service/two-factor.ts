// Xác thực hai lớp TOTP của tài khoản (#7 [D], spec 5.4, 6.7 "Login 2FA", "Setup, confirm"). Cột TOTP của
// staff.accounts ghi bằng role chủ bảng (ngoài withCompany, migration 0017). Bộ đếm sai 5 lần trong 15 phút nằm ở route.
import { assertTokenCurrent } from '../../../shared/auth/company-access.ts';
import type { AccessClaims } from '../../../shared/auth/jwt.ts';
import { PurposeTokenError, verifyPurposeToken } from '../../../shared/auth/purpose-token.ts';
import { matchTotp } from '../../../shared/crypto/totp.ts';
import { inTransaction } from '../../../shared/db/client.ts';
import { AppError } from '../../../shared/errors/app-error.ts';
import { logger } from '../../../shared/logger.ts';
import { isUuid } from '../../../shared/uuid.ts';
import { recordAudit } from '../../audit/index.ts';
import {
  type AccountRow,
  advanceTotpStep,
  clearTotp,
  consumeRecoveryCode,
  enableTotp,
  findAccountById,
  hashRecoveryCode,
  newRecoveryCodes,
  newTotpSetup,
  openTotpSecret,
  saveTotpSecret,
  sealTotpSecret,
} from '../../staff/index.ts';
import { findActiveRefreshToken, revokeAllRefreshTokens } from '../repository/refresh-tokens.ts';
import { countLogin, countTwoFactor } from './metrics.ts';
import { hashToken, type LoginResult, newRefreshToken, startSession } from './session.ts';

const unauthorized = () =>
  new AppError(401, 'unauthorized', 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn, hãy đăng nhập lại');
const invalidCode = () => new AppError(401, 'two_factor_invalid', 'Mã xác thực không đúng hoặc đã được dùng');
const alreadyEnabled = () => new AppError(409, 'two_factor_already_enabled', 'Tài khoản đã bật xác thực hai lớp');
const wrongSetupCode = () =>
  new AppError(422, 'validation_failed', 'Dữ liệu gửi lên không hợp lệ', {
    errors: { code: 'Mã không đúng, hãy nhập mã đang hiện trên app' },
  });

/** Người gọi bằng access token; token phát trước lần đổi mật khẩu gần nhất thì 401 (#62). */
async function caller(auth: AccessClaims): Promise<AccountRow> {
  const account = await findAccountById(auth.accountId);
  if (!account) throw unauthorized();
  assertTokenCurrent(auth, account.passwordChangedAt);
  return account;
}

/** Sinh secret mới (gọi lại thì thay bản chưa xác nhận). DB chỉ giữ bản mã hoá. */
export async function beginSetup(auth: AccessClaims): Promise<{ secret: string; otpauthUrl: string }> {
  const account = await caller(auth);
  if (account.totpEnabledAt) throw alreadyEnabled();
  const setup = newTotpSetup(account.email);
  if (!(await saveTotpSecret(account.id, sealTotpSecret(setup.raw, account.id)))) throw alreadyEnabled();
  logger.info({ accountId: account.id }, 'bắt đầu thiết lập xác thực hai lớp');
  return { secret: setup.secret, otpauthUrl: setup.otpauthUrl };
}

/**
 * Mã đúng thì bật 2FA, ghi bước của mã (không dùng lại được ở `/login/2fa`), trả 2 mã khôi phục một lần. Mọi refresh
 * token cấp trước đó chỉ qua mật khẩu nên bị thu hồi (không thì phiên đó `refresh` ra token không cờ mà chưa từng nhập
 * mã); phiên đang xác nhận nhận cookie mới, giống đổi mật khẩu.
 */
export async function confirmSetup(
  auth: AccessClaims,
  code: string,
  refreshToken: string | undefined,
): Promise<{ recoveryCodes: string[]; refreshToken: string }> {
  const account = await caller(auth);
  if (account.totpEnabledAt) throw alreadyEnabled();
  const sealed = account.totpSecretEnc;
  // Chưa gọi `setup` thì không có mã nào đúng.
  const step = sealed ? matchTotp(openTotpSecret(sealed, account.id), code, Date.now()) : null;
  if (!sealed || step === null) {
    countTwoFactor('invalid');
    throw wrongSetupCode();
  }
  const { codes, hashes } = newRecoveryCodes();
  const session = refreshToken ? await findActiveRefreshToken(hashToken(refreshToken)) : undefined;
  const companyId = session?.accountId === account.id ? session.companyId : null;
  const token = await inTransaction(async () => {
    // `setup` chen giữa thì secret đã đổi: không bật bằng secret mà mã chưa kiểm.
    if (!(await enableTotp(account.id, step, hashes, sealed))) throw alreadyEnabled();
    await revokeAllRefreshTokens(account.id);
    return newRefreshToken(account.id, companyId);
  });
  countTwoFactor('ok');
  logger.info({ accountId: account.id }, 'đã bật xác thực hai lớp');
  return { recoveryCodes: codes, refreshToken: token };
}

/**
 * Bước thứ hai sau `/login`, `/google` (đúng một trong `code`, `recoveryCode`). Mã TOTP đúng mà bước đã dùng thì cũng
 * 401 `two_factor_invalid`: hai request cùng mã thì đúng một qua.
 */
export async function loginSecondFactor(input: {
  mfaToken: string;
  code?: string;
  recoveryCode?: string;
}): Promise<LoginResult> {
  const claims = await verifyPurposeToken('mfa', input.mfaToken).catch((err: unknown) => {
    if (err instanceof PurposeTokenError) throw unauthorized();
    throw err;
  });
  const account = claims.sub ? await findAccountById(claims.sub) : undefined;
  // Quản trị nền tảng vừa đặt lại 2FA: đăng nhập lại từ đầu.
  if (!account?.totpEnabledAt || !account.totpSecretEnc) throw unauthorized();
  if (input.code !== undefined) {
    const step = matchTotp(openTotpSecret(account.totpSecretEnc, account.id), input.code, Date.now());
    if (step === null) {
      countTwoFactor('invalid');
      logger.warn({ accountId: account.id }, 'sai mã xác thực hai lớp');
      throw invalidCode();
    }
    if (!(await advanceTotpStep(account.id, step))) {
      countTwoFactor('replay');
      logger.warn({ accountId: account.id }, 'mã xác thực hai lớp đã được dùng');
      throw invalidCode();
    }
    countTwoFactor('ok');
  } else {
    if (!(await consumeRecoveryCode(account.id, hashRecoveryCode(input.recoveryCode ?? '')))) {
      countTwoFactor('invalid');
      logger.warn({ accountId: account.id }, 'sai mã khôi phục');
      throw invalidCode();
    }
    countTwoFactor('recovery');
    logger.warn({ accountId: account.id }, 'đăng nhập bằng mã khôi phục');
  }
  const session = await startSession(account);
  countLogin('mfa', 'ok');
  return session;
}

/**
 * Quản trị nền tảng đặt lại 2FA khi người dùng mất điện thoại và hết mã khôi phục (#7 [D], AC-D10): xoá secret, cờ bật,
 * mã khôi phục, thu hồi mọi refresh token; lần đăng nhập sau phải thiết lập lại. Nhật ký cấp nền tảng. Gọi lại vẫn được.
 * Admin, CEO công ty không làm được vì tài khoản dùng chung nhiều công ty (Q11).
 */
export async function resetTwoFactor(accountId: string, actorId: string): Promise<void> {
  if (!isUuid(accountId)) throw new AppError(404, 'not_found', 'Không tìm thấy tài khoản');
  await inTransaction(async () => {
    if (!(await clearTotp(accountId))) throw new AppError(404, 'not_found', 'Không tìm thấy tài khoản');
    await revokeAllRefreshTokens(accountId);
    await recordAudit({
      companyId: null,
      actorId,
      action: 'update',
      entityType: 'staff.accounts',
      entityId: accountId,
      after: { twoFactorReset: true },
    });
  });
  logger.info({ accountId, actorId }, 'quản trị nền tảng đã đặt lại xác thực hai lớp');
}

/** Loader cho guard quản trị nền tảng (`src/wiring.ts`): cờ và dấu đổi mật khẩu đọc thẳng DB. */
export async function platformAdminOf(accountId: string) {
  const account = await findAccountById(accountId);
  return account && { isPlatformAdmin: account.isPlatformAdmin, passwordChangedAt: account.passwordChangedAt };
}
