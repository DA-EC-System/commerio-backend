// Đăng nhập Google cho tài khoản đã có (#7 [A], Documents/21 A6). FE lấy ID token bằng Google Identity Services,
// BE kiểm chữ ký bằng khoá công khai của Google, rồi tìm tài khoản theo `sub` đã liên kết, không có thì theo email
// đã xác minh. Google không tạo tài khoản.
import { createRemoteJWKSet, errors, type JWTVerifyGetKey, jwtVerify } from 'jose';
import { env } from '../../../shared/config/env.ts';
import { inTransaction } from '../../../shared/db/client.ts';
import { pgError } from '../../../shared/db/pg-error.ts';
import { AppError } from '../../../shared/errors/app-error.ts';
import { logger } from '../../../shared/logger.ts';
import { recordAudit } from '../../audit/index.ts';
import { type AccountRow, findAccountByEmail, findAccountByGoogleSub, findAccountById, linkGoogleSub } from '../../staff/index.ts';
import { countLogin } from './metrics.ts';
import { afterFirstFactor, isMfaChallenge, type LoginResult, type MfaChallenge } from './session.ts';

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

// Một bộ khoá cho cả tiến trình: jose giữ khoá trong bộ nhớ, tải lại khi gặp `kid` lạ.
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), {
  timeoutDuration: 5000,
});
let keySource: JWTVerifyGetKey | null = null;

/** Test thay khoá của Google bằng khoá tự sinh; `null` thì quay lại khoá thật. */
export function setGoogleKeySource(source: JWTVerifyGetKey | null): void {
  keySource = source;
}

// Lỗi của chính token. Lỗi khác (không tải được khoá, Google trả lỗi, mạng) là phía Google không sẵn sàng.
const TOKEN_ERRORS = [
  errors.JWTExpired,
  errors.JWTClaimValidationFailed,
  errors.JWTInvalid,
  errors.JWSInvalid,
  errors.JWSSignatureVerificationFailed,
  errors.JOSEAlgNotAllowed,
  errors.JOSENotSupported,
  errors.JWKSNoMatchingKey,
  errors.JWKSMultipleMatchingKeys,
];

const tokenInvalid = () => new AppError(401, 'google_token_invalid', 'Phiên đăng nhập Google không hợp lệ, hãy thử lại');
const unavailable = () =>
  new AppError(503, 'google_unavailable', 'Chưa kết nối được tới Google, hãy thử lại sau hoặc đăng nhập bằng mật khẩu');
const accountNotFound = () =>
  new AppError(401, 'google_account_not_found', 'Tài khoản Google này chưa gắn với tài khoản Commerio nào');

/** Kiểm ID token: chữ ký, `iss`, `aud`, hạn, `email_verified === true`. Trả `sub` và email chữ thường. */
export async function verifyGoogleCredential(credential: string): Promise<{ sub: string; email: string }> {
  if (!env.GOOGLE_CLIENT_ID) {
    logger.error('chưa đặt GOOGLE_CLIENT_ID, không kiểm được ID token Google');
    throw unavailable();
  }
  let payload;
  try {
    ({ payload } = await jwtVerify(credential, keySource ?? googleKeys, {
      issuer: GOOGLE_ISSUERS,
      audience: env.GOOGLE_CLIENT_ID,
      algorithms: ['RS256'],
    }));
  } catch (err) {
    if (TOKEN_ERRORS.some((type) => err instanceof type)) throw tokenInvalid();
    logger.error({ err }, 'không lấy được khoá công khai của Google');
    throw unavailable();
  }
  if (payload.email_verified !== true || typeof payload.email !== 'string' || typeof payload.sub !== 'string') {
    throw tokenInvalid();
  }
  return { sub: payload.sub, email: payload.email.trim().toLowerCase() };
}

/**
 * Liên kết `sub` vào tài khoản tìm theo email (chạy ngoài `withCompany`, migration 0017). Không trúng dòng thì đọc
 * lại: cùng `sub` (hai request của cùng người) coi như đã liên kết, khác thì 401. Lần đầu ghi nhật ký cấp tài khoản.
 */
async function linkAccount(account: AccountRow, sub: string): Promise<void> {
  try {
    const linked = await inTransaction(async () => {
      if (!(await linkGoogleSub(account.id, sub))) return false;
      await recordAudit({
        companyId: null,
        actorId: account.id,
        action: 'update',
        entityType: 'staff.accounts',
        entityId: account.id,
        after: { googleLinked: true },
      });
      return true;
    });
    if (linked) {
      logger.info({ accountId: account.id }, 'đã liên kết tài khoản Google');
      return;
    }
  } catch (err) {
    const { code, constraint } = pgError(err);
    if (code === '23505' && constraint === 'accounts_google_sub_unique') throw accountNotFound();
    throw err;
  }
  if ((await findAccountById(account.id))?.googleSub !== sub) throw accountNotFound();
}

/**
 * Việc cần làm với tài khoản tìm theo email khi chưa tìm thấy theo `sub`. Đã gắn đúng `sub` này: request khác của cùng
 * người vừa liên kết xong giữa hai lần đọc, coi như đã liên kết (spec #7 mục 6.7). Gắn `sub` khác: không đổi liên kết
 * (Documents/21 V11).
 */
export function googleLinkStep(account: AccountRow | undefined, sub: string): 'link' | 'linked' | 'not_found' {
  if (!account) return 'not_found';
  if (account.googleSub === null) return 'link';
  return account.googleSub === sub ? 'linked' : 'not_found';
}

/** UC-PI-03 extend: đăng nhập bằng Google, phản hồi như `/login`. */
export async function loginWithGoogle(credential: string): Promise<LoginResult | MfaChallenge> {
  let identity;
  try {
    identity = await verifyGoogleCredential(credential);
  } catch (err) {
    countLogin('google', err instanceof AppError && err.status === 503 ? 'unavailable' : 'invalid');
    throw err;
  }
  try {
    let account = await findAccountByGoogleSub(identity.sub);
    if (!account) {
      const byEmail = await findAccountByEmail(identity.email);
      const step = googleLinkStep(byEmail, identity.sub);
      if (step === 'not_found') throw accountNotFound();
      if (step === 'link') await linkAccount(byEmail!, identity.sub);
      account = byEmail!;
    }
    const result = await afterFirstFactor(account);
    countLogin('google', isMfaChallenge(result) ? 'mfa_required' : 'ok');
    return result;
  } catch (err) {
    if (err instanceof AppError && err.code === 'google_account_not_found') countLogin('google', 'not_found');
    throw err;
  }
}
