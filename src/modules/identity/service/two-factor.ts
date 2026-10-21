// Xác thực hai lớp TOTP của tài khoản (#7 [D], spec 5.4, 6.7 "Login 2FA", "Setup, confirm"). Cột TOTP của
// staff.accounts ghi bằng role chủ bảng (ngoài withCompany, migration 0017). Bộ đếm sai 5 lần trong 15 phút nằm ở route.
import { assertTokenCurrent } from '../../../shared/auth/company-access.ts';
import type { AccessClaims } from '../../../shared/auth/jwt.ts';
import { PurposeTokenError, verifyPurposeToken } from '../../../shared/auth/purpose-token.ts';
import { matchTotp } from '../../../shared/crypto/totp.ts';
import { AppError } from '../../../shared/errors/app-error.ts';
import { logger } from '../../../shared/logger.ts';
import {
  type AccountRow,
  advanceTotpStep,
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
import { countLogin, countTwoFactor } from './metrics.ts';
import { type LoginResult, startSession } from './session.ts';

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

/** Mã đúng thì bật 2FA, ghi bước của mã (không dùng lại được ở `/login/2fa`), trả 2 mã khôi phục một lần. */
export async function confirmSetup(auth: AccessClaims, code: string): Promise<{ recoveryCodes: string[] }> {
  const account = await caller(auth);
  if (account.totpEnabledAt) throw alreadyEnabled();
  // Chưa gọi `setup` thì không có mã nào đúng.
  const step = account.totpSecretEnc
    ? matchTotp(openTotpSecret(account.totpSecretEnc, account.id), code, Date.now())
    : null;
  if (step === null) {
    countTwoFactor('invalid');
    throw wrongSetupCode();
  }
  const { codes, hashes } = newRecoveryCodes();
  if (!(await enableTotp(account.id, step, hashes))) throw alreadyEnabled();
  countTwoFactor('ok');
  logger.info({ accountId: account.id }, 'đã bật xác thực hai lớp');
  return { recoveryCodes: codes };
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
