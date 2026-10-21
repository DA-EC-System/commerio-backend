import { createLocalJWKSet, errors, exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { googleLinkStep, setGoogleKeySource, verifyGoogleCredential } from '#src/modules/identity/service/google.ts';
import type { AccountRow } from '#src/modules/staff/index.ts';

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
let privateKey: CryptoKey;
let googleKeys: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  googleKeys = createLocalJWKSet({ keys: [jwk] });
  setGoogleKeySource(googleKeys);
});

afterAll(() => setGoogleKeySource(null));

/** ID token giống của Google Identity Services, ghi đè từng claim để thử ca sai. */
async function sign(overrides: JWTPayload & { email_verified?: unknown } = {}, key: CryptoKey = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: 'g-1',
    email: 'a@x.vn',
    email_verified: true,
    iat: now,
    exp: now + 3600,
    ...overrides,
  };
  return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).sign(key);
}

// Kiểm ID token Google (#7 [A], spec 6.5): sai thì 401, không lấy được khoá thì 503.
describe('verifyGoogleCredential', () => {
  it('token hợp lệ trả sub và email chữ thường', async () => {
    expect(await verifyGoogleCredential(await sign({ email: 'A@X.vn' }))).toEqual({ sub: 'g-1', email: 'a@x.vn' });
  });

  it('nhận cả iss dạng không có https', async () => {
    expect(await verifyGoogleCredential(await sign({ iss: 'accounts.google.com' }))).toMatchObject({ sub: 'g-1' });
  });

  it.each([
    ['sai aud', { aud: 'khac.apps.googleusercontent.com' }],
    ['sai iss', { iss: 'https://evil.example' }],
    ['email_verified false', { email_verified: false }],
    ['email_verified là chuỗi', { email_verified: 'true' }],
    ['thiếu email', { email: undefined }],
    ['hết hạn', { exp: Math.floor(Date.now() / 1000) - 600, iat: Math.floor(Date.now() / 1000) - 4000 }],
  ])('%s → 401 google_token_invalid', async (_name, claims) => {
    await expect(verifyGoogleCredential(await sign(claims))).rejects.toMatchObject({ status: 401, code: 'google_token_invalid' });
  });

  it('ký bằng khoá khác → 401 google_token_invalid', async () => {
    const other = await generateKeyPair('RS256');
    await expect(verifyGoogleCredential(await sign({}, other.privateKey))).rejects.toMatchObject({
      status: 401,
      code: 'google_token_invalid',
    });
  });

  it('chuỗi không phải JWT → 401 google_token_invalid', async () => {
    await expect(verifyGoogleCredential('khong-phai-jwt-abcdefghijk')).rejects.toMatchObject({ code: 'google_token_invalid' });
  });

  it('không lấy được khoá (JWKSTimeout) → 503 google_unavailable', async () => {
    const token = await sign();
    setGoogleKeySource(() => {
      throw new errors.JWKSTimeout();
    });
    try {
      await expect(verifyGoogleCredential(token)).rejects.toMatchObject({ status: 503, code: 'google_unavailable' });
    } finally {
      setGoogleKeySource(googleKeys);
    }
  });

  it('lỗi mạng khi tải khoá → 503 google_unavailable', async () => {
    const token = await sign();
    setGoogleKeySource(() => Promise.reject(new TypeError('fetch failed')));
    try {
      await expect(verifyGoogleCredential(token)).rejects.toMatchObject({ status: 503, code: 'google_unavailable' });
    } finally {
      setGoogleKeySource(googleKeys);
    }
  });
});

// Tài khoản tìm theo email khi chưa thấy `sub` (#7 spec 6.7): request cùng người vừa liên kết xong giữa hai lần đọc.
describe('googleLinkStep', () => {
  const account = (googleSub: string | null): AccountRow => ({
    id: 'a1',
    email: 'a@x.vn',
    fullName: 'A',
    passwordHash: null,
    mustChangePassword: false,
    isPlatformAdmin: false,
    passwordChangedAt: null,
    googleSub,
    totpSecretEnc: null,
    totpEnabledAt: null,
  });

  it('không có tài khoản → not_found', () => expect(googleLinkStep(undefined, 'g-1')).toBe('not_found'));
  it('chưa liên kết → link', () => expect(googleLinkStep(account(null), 'g-1')).toBe('link'));
  it('đã liên kết đúng sub này (request khác vừa ghi) → linked, không 401', () =>
    expect(googleLinkStep(account('g-1'), 'g-1')).toBe('linked'));
  it('đã liên kết sub khác → not_found', () => expect(googleLinkStep(account('g-2'), 'g-1')).toBe('not_found'));
});
