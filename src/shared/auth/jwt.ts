import { type CryptoKey, generateKeyPair, importPKCS8, importSPKI, jwtVerify, SignJWT } from 'jose';
import { env } from '../config/env.ts';
import { AppError } from '../errors/app-error.ts';
import { logger } from '../logger.ts';

const ALG = 'EdDSA';
const ISSUER = 'commerio';
/** Access token sống 15 phút (Documents/21 A2); làm mới bằng refresh token trong cookie. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** Thông tin người gọi lấy từ access token. */
export interface AccessClaims {
  readonly accountId: string;
  /** Công ty đã chọn; `null` khi mới đăng nhập, chưa chọn công ty. */
  readonly companyId: string | null;
  /** Quyền trong công ty đã chọn, đã bỏ quyền của phân hệ chưa bật. */
  readonly permissions: readonly string[];
  /** Còn mật khẩu trong thư mời: chỉ được gọi vài API (Documents/21 V10). */
  readonly mustChangePassword: boolean;
}

let keys: Promise<{ privateKey: CryptoKey; publicKey: CryptoKey }> | undefined;

function loadKeys() {
  keys ??= (async () => {
    if (env.JWT_PRIVATE_KEY && env.JWT_PUBLIC_KEY) {
      const pem = (s: string) => s.replace(/\\n/g, '\n');
      return {
        privateKey: await importPKCS8(pem(env.JWT_PRIVATE_KEY), ALG),
        publicKey: await importSPKI(pem(env.JWT_PUBLIC_KEY), ALG),
      };
    }
    if (env.NODE_ENV === 'production') throw new Error('Chưa đặt JWT_PRIVATE_KEY và JWT_PUBLIC_KEY');
    logger.warn('Chưa đặt khoá JWT, dùng khoá tạm sinh lúc khởi động');
    return generateKeyPair(ALG);
  })();
  return keys;
}

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  const { privateKey } = await loadKeys();
  return new SignJWT({
    cid: claims.companyId,
    perms: claims.permissions,
    pwc: claims.mustChangePassword,
  })
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setSubject(claims.accountId)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(privateKey);
}

/** Kiểm chữ ký và hạn của access token. Sai hay hết hạn thì 401 `unauthorized`. */
export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const { publicKey } = await loadKeys();
  try {
    const { payload } = await jwtVerify(token, publicKey, { issuer: ISSUER, algorithms: [ALG] });
    return {
      accountId: String(payload.sub),
      companyId: typeof payload.cid === 'string' ? payload.cid : null,
      permissions: Array.isArray(payload.perms) ? payload.perms.map(String) : [],
      mustChangePassword: payload.pwc === true,
    };
  } catch {
    throw new AppError(401, 'unauthorized', 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn');
  }
}
