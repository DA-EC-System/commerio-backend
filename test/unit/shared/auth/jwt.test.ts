import { describe, expect, it } from 'vitest';
import { ACCESS_TOKEN_TTL_SECONDS, assertTokenCurrent, signAccessToken, verifyAccessToken } from '#src/shared/auth/jwt.ts';

describe('access token', () => {
  it('verifyAccessToken trả expiresAt (giây epoch) đúng 15 phút sau lúc ký', async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await signAccessToken({
      accountId: '7d1b6c1e-0000-4000-8000-000000000001',
      companyId: null,
      permissions: [],
      mustChangePassword: false,
      passwordChangedAt: null,
    });
    const claims = await verifyAccessToken(token);
    const iat = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).iat as number;
    expect(claims.expiresAt - iat).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(iat).toBeGreaterThanOrEqual(before);
  });
});

describe('dấu đổi mật khẩu trong access token (#62)', () => {
  const base = { accountId: '7d1b6c1e-0000-4000-8000-000000000001', companyId: null, permissions: [], mustChangePassword: false, passwordChangedAt: null };

  it('token không có dấu (chưa từng đổi, hoặc phát trước #62: thiếu claim cũng đọc ra null) qua được khi DB trống', async () => {
    const claims = await verifyAccessToken(await signAccessToken(base));
    expect(claims.passwordChangedAt).toBeNull();
    expect(() => assertTokenCurrent(claims, null)).not.toThrow();
    expect(() => assertTokenCurrent(claims, new Date())).toThrow(expect.objectContaining({ status: 401, code: 'unauthorized' }));
  });

  it('dấu khớp đến từng mili giây thì qua; đổi mật khẩu sau đó (khác dấu) thì 401', async () => {
    const changedAt = new Date('2026-10-19T08:00:00.123Z');
    const claims = await verifyAccessToken(await signAccessToken({ ...base, passwordChangedAt: changedAt.getTime() }));
    expect(() => assertTokenCurrent(claims, new Date(changedAt.getTime()))).not.toThrow();
    expect(() => assertTokenCurrent(claims, new Date(changedAt.getTime() + 1))).toThrow(
      expect.objectContaining({ status: 401, code: 'unauthorized' }),
    );
  });
});
