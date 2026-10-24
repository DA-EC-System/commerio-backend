import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose';
import { afterAll, beforeAll } from 'vitest';
import { setGoogleKeySource } from '#src/modules/core/identity/service/google.ts';

/**
 * Google giả cho cả file test: khoá RS256 tự sinh thay JWKS của Google (không gọi mạng). Trả hàm ký ID token
 * như Google Identity Services, mặc định hợp lệ với `GOOGLE_CLIENT_ID` của `vitest.config.ts`.
 */
export function useFakeGoogle() {
  let privateKey: CryptoKey | undefined;
  let keys: ReturnType<typeof createLocalJWKSet> | undefined;
  beforeAll(async () => {
    const pair = await generateKeyPair('RS256', { extractable: true });
    privateKey = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test', alg: 'RS256', use: 'sig' };
    keys = createLocalJWKSet({ keys: [jwk] });
    setGoogleKeySource(keys);
  });
  afterAll(() => setGoogleKeySource(null));

  /** Đặt lại khoá giả sau khi test thay nguồn khoá (vd giả Google không trả khoá). */
  const restoreKeys = () => setGoogleKeySource(keys!);

  async function googleToken(claims: JWTPayload & { email?: string; email_verified?: unknown }) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      iss: 'https://accounts.google.com',
      aud: process.env.GOOGLE_CLIENT_ID,
      email_verified: true,
      iat: now,
      exp: now + 3600,
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .sign(privateKey!);
  }

  return { googleToken, restoreKeys };
}
