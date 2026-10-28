// Token mục đích riêng (#7 spec 6.6): link mời (`invite`), đăng ký sau OTP (`join`), bước nhập mã 2FA (`mfa`),
// `state` của OAuth sàn (`oauth`, #103).
// Ký cùng khoá Ed25519 với access token nhưng issuer riêng `commerio-<mục đích>`: `verifyAccessToken` đòi issuer
// `commerio`, nên không loại nào dùng nhầm làm loại khác được.
import { jwtVerify, SignJWT } from 'jose';
import { signingKeys } from './jwt.ts';

const ALG = 'EdDSA';

export type TokenPurpose = 'invite' | 'join' | 'mfa' | 'oauth';

export const PURPOSE_TTL_SECONDS = { invite: 72 * 3600, join: 30 * 60, mfa: 5 * 60, oauth: 10 * 60 } as const;

export interface PurposeClaims {
  /** Id lời mời. */
  jti?: string;
  /** Id tài khoản (`mfa`). */
  sub?: string;
  /** Công ty của lời mời, để mở `withCompany` trước khi đọc dòng. */
  cid?: string;
  /** Email đã xác minh bằng OTP (`join`). */
  em?: string;
  /** Bước kế tiếp của người được mời (`join`). */
  nxt?: 'set_password' | 'sign_in';
  /** Sàn của lần uỷ quyền (`oauth`). */
  plt?: string;
}

/** Sai chữ ký, sai issuer, hết hạn hoặc không phải JWT. Bên gọi đổi thành mã lỗi của luồng mình. */
export class PurposeTokenError extends Error {
  constructor() {
    super('Token không hợp lệ hoặc đã hết hạn');
    this.name = 'PurposeTokenError';
  }
}

const issuerOf = (purpose: TokenPurpose) => `commerio-${purpose}`;

export async function signPurposeToken(purpose: TokenPurpose, claims: PurposeClaims): Promise<string> {
  const { privateKey } = await signingKeys();
  const { jti, sub, ...rest } = claims;
  const jwt = new SignJWT({ ...rest })
    .setProtectedHeader({ alg: ALG })
    .setIssuer(issuerOf(purpose))
    .setIssuedAt()
    .setExpirationTime(`${PURPOSE_TTL_SECONDS[purpose]}s`);
  if (jti) jwt.setJti(jti);
  if (sub) jwt.setSubject(sub);
  return jwt.sign(privateKey);
}

export async function verifyPurposeToken(purpose: TokenPurpose, token: string): Promise<PurposeClaims & { exp: number }> {
  const { publicKey } = await signingKeys();
  try {
    const { payload } = await jwtVerify(token, publicKey, { issuer: issuerOf(purpose), algorithms: [ALG] });
    const text = (v: unknown) => (typeof v === 'string' ? v : undefined);
    const nxt = payload.nxt === 'set_password' || payload.nxt === 'sign_in' ? payload.nxt : undefined;
    return {
      jti: text(payload.jti),
      sub: text(payload.sub),
      cid: text(payload.cid),
      em: text(payload.em),
      nxt,
      plt: text(payload.plt),
      exp: Number(payload.exp),
    };
  } catch {
    throw new PurposeTokenError();
  }
}
