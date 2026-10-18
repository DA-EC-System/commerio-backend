import { describe, expect, it } from 'vitest';
import { ACCESS_TOKEN_TTL_SECONDS, signAccessToken, verifyAccessToken } from '#src/shared/auth/jwt.ts';

describe('access token', () => {
  it('verifyAccessToken trả expiresAt (giây epoch) đúng 15 phút sau lúc ký', async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await signAccessToken({
      accountId: '7d1b6c1e-0000-4000-8000-000000000001',
      companyId: null,
      permissions: [],
      mustChangePassword: false,
    });
    const claims = await verifyAccessToken(token);
    const iat = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).iat as number;
    expect(claims.expiresAt - iat).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(iat).toBeGreaterThanOrEqual(before);
  });
});
