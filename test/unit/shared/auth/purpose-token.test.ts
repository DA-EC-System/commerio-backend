import { afterEach, describe, expect, it, vi } from 'vitest';
import { signAccessToken, verifyAccessToken } from '#src/shared/auth/jwt.ts';
import { PURPOSE_TTL_SECONDS, PurposeTokenError, signPurposeToken, verifyPurposeToken } from '#src/shared/auth/purpose-token.ts';

const ID = '7d1b6c1e-0000-4000-8000-000000000001';
const CID = '7d1b6c1e-0000-4000-8000-000000000002';
const base = { accountId: ID, companyId: null, permissions: [], mustChangePassword: false, passwordChangedAt: null };

afterEach(() => {
  vi.useRealTimers();
});

// Token link mời, token đăng ký, mfaToken: cùng khoá với access token nhưng issuer riêng (#7 spec 6.6).
describe('token mục đích riêng', () => {
  it('ký rồi đọc lại đúng claim', async () => {
    const token = await signPurposeToken('join', { jti: ID, cid: CID, em: 'a@x.vn', nxt: 'sign_in' });
    expect(await verifyPurposeToken('join', token)).toMatchObject({ jti: ID, cid: CID, em: 'a@x.vn', nxt: 'sign_in' });
  });

  it('token mfa mang sub', async () => {
    const token = await signPurposeToken('mfa', { sub: ID });
    expect(await verifyPurposeToken('mfa', token)).toMatchObject({ sub: ID });
  });

  it('token invite không qua được verifyAccessToken', async () => {
    const token = await signPurposeToken('invite', { jti: ID, cid: CID });
    await expect(verifyAccessToken(token)).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
  });

  it('token mfa không qua được verifyAccessToken', async () => {
    const token = await signPurposeToken('mfa', { sub: ID });
    await expect(verifyAccessToken(token)).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
  });

  it('access token không qua được verifyPurposeToken("invite")', async () => {
    await expect(verifyPurposeToken('invite', await signAccessToken(base))).rejects.toBeInstanceOf(PurposeTokenError);
  });

  it('token join không qua được verifyPurposeToken("invite")', async () => {
    const token = await signPurposeToken('join', { jti: ID, cid: CID, em: 'a@x.vn', nxt: 'set_password' });
    await expect(verifyPurposeToken('invite', token)).rejects.toBeInstanceOf(PurposeTokenError);
  });

  it('chuỗi không phải JWT hoặc chữ ký bị sửa thì ném PurposeTokenError', async () => {
    await expect(verifyPurposeToken('invite', 'abc')).rejects.toBeInstanceOf(PurposeTokenError);
    const token = await signPurposeToken('invite', { jti: ID, cid: CID });
    const tampered = `${token.slice(0, -2)}${token.endsWith('AA') ? 'BB' : 'AA'}`;
    await expect(verifyPurposeToken('invite', tampered)).rejects.toBeInstanceOf(PurposeTokenError);
  });

  it('thời hạn: link 72 giờ, đăng ký 30 phút, mfa 5 phút, state OAuth 10 phút', () => {
    expect(PURPOSE_TTL_SECONDS).toEqual({ invite: 72 * 3600, join: 30 * 60, mfa: 5 * 60, oauth: 10 * 60 });
  });

  it('token invite còn hạn ngay trước 72 giờ, hết hạn sau đúng 72 giờ', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-21T00:00:00Z'), toFake: ['Date'] });
    const token = await signPurposeToken('invite', { jti: ID, cid: CID });
    const claims = await verifyPurposeToken('invite', token);
    expect(claims.exp).toBe(Date.parse('2026-10-24T00:00:00Z') / 1000);
    vi.setSystemTime(new Date('2026-10-23T23:59:59Z'));
    await expect(verifyPurposeToken('invite', token)).resolves.toMatchObject({ jti: ID });
    vi.setSystemTime(new Date('2026-10-24T00:00:01Z'));
    await expect(verifyPurposeToken('invite', token)).rejects.toBeInstanceOf(PurposeTokenError);
  });

  it('token mfa hết hạn sau 5 phút', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-21T00:00:00Z'), toFake: ['Date'] });
    const token = await signPurposeToken('mfa', { sub: ID });
    vi.setSystemTime(new Date('2026-10-21T00:05:01Z'));
    await expect(verifyPurposeToken('mfa', token)).rejects.toBeInstanceOf(PurposeTokenError);
  });
});
