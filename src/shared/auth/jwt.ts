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
  /** Hết hạn lúc nào (giây epoch, `exp` của token): kênh SSE đóng đúng lúc này (Documents/21 D11). */
  readonly expiresAt: number;
  /** `staff.accounts.password_changed_at` lúc ký (ms epoch); `null` khi chưa từng đổi hoặc token phát trước #62. */
  readonly passwordChangedAt: number | null;
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

export type SignClaims = Omit<AccessClaims, 'expiresAt' | 'passwordChangedAt'> & { readonly passwordChangedAt?: number | null };

export async function signAccessToken(claims: SignClaims): Promise<string> {
  const { privateKey } = await loadKeys();
  return new SignJWT({
    cid: claims.companyId,
    perms: claims.permissions,
    pwc: claims.mustChangePassword,
    pca: claims.passwordChangedAt ?? null,
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
      expiresAt: Number(payload.exp),
      passwordChangedAt: typeof payload.pca === 'number' ? payload.pca : null,
    };
  } catch {
    throw new AppError(401, 'unauthorized', 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn');
  }
}

/**
 * Token phát trước lần đổi mật khẩu gần nhất hết hiệu lực ngay (#62): dấu trong token phải bằng
 * `password_changed_at` hiện tại (so tới mili giây, nên không lọt token phát cùng giây với lần đổi). Khác thì 401.
 */
export function assertTokenCurrent(claims: AccessClaims, passwordChangedAt: Date | null): void {
  if (claims.passwordChangedAt !== (passwordChangedAt?.getTime() ?? null)) {
    throw new AppError(401, 'unauthorized', 'Phiên đăng nhập đã hết hiệu lực vì mật khẩu vừa được đổi, hãy đăng nhập lại');
  }
}
