import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Bật 2FA bắt buộc cho file này (#7 [D], AC-D1..D7). Đọc env trước khi nạp code.
vi.hoisted(() => {
  process.env.TWO_FACTOR_MODE = 'required';
});

const { verifyAccessToken } = await import('#src/shared/auth/jwt.ts');
const { signPurposeToken } = await import('#src/shared/auth/purpose-token.ts');
const { base32Decode, TOTP_STEP_SECONDS, totpAt } = await import('#src/shared/crypto/totp.ts');
const { registerCompany } = await import('../helpers/company.ts');
const { testPool } = await import('../helpers/db.ts');
const { PASSWORD, refreshCookie, testApp } = await import('../helpers/http.ts');
const { useFakeGoogle } = await import('./helpers.ts');

const app = testApp();
const db = testPool();
const { googleToken } = useFakeGoogle();

afterEach(() => vi.useRealTimers());

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const currentStep = () => Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
const loginWithPassword = (email: string) =>
  request(app).post('/api/v1/identity/login').send({ email, password: PASSWORD });
const secondFactor = (body: object) => request(app).post('/api/v1/identity/login/2fa').send(body);

/** Mã 6 số không trùng mã của các bước quanh hiện tại (mã sai chắc chắn). */
function wrongCode(secret: Buffer): string {
  const near = new Set([-2, -1, 0, 1, 2].map((d) => totpAt(secret, currentStep() + d)));
  for (let n = 0; ; n++) {
    const code = String(n).padStart(6, '0');
    if (!near.has(code)) return code;
  }
}

/** Tài khoản mới đăng nhập lần đầu (token có cờ tfs), thiết lập và xác nhận 2FA. */
async function enrolled() {
  const { email, companyId } = await registerCompany();
  const first = await loginWithPassword(email);
  const token = first.body.accessToken as string;
  const setup = await request(app).post('/api/v1/identity/2fa/setup').set(bearer(token));
  expect(setup.status).toBe(200);
  const secret = base32Decode(setup.body.secret);
  const confirm = await request(app)
    .post('/api/v1/identity/2fa/confirm')
    .set(bearer(token))
    .send({ code: totpAt(secret, currentStep()) });
  expect(confirm.status).toBe(200);
  return {
    email,
    companyId,
    token,
    secret,
    cookie: refreshCookie(first),
    recoveryCodes: confirm.body.recoveryCodes as string[],
  };
}

/** Đăng nhập mật khẩu của tài khoản đã bật 2FA, trả `mfaToken`. */
async function challenge(email: string): Promise<string> {
  const res = await loginWithPassword(email);
  expect(res.body.mfaRequired).toBe(true);
  return res.body.mfaToken as string;
}

describe('2FA bắt buộc', () => {
  it('AC-D6: chưa bật 2FA → token có cờ tfs; chỉ me, change-password, 2fa/*, refresh, logout dùng được', async () => {
    const { email, companyId } = await registerCompany();
    const login = await loginWithPassword(email);
    expect(login.status).toBe(200);
    const token = login.body.accessToken as string;
    expect((await verifyAccessToken(token)).twoFactorSetupRequired).toBe(true);

    expect((await request(app).get('/api/v1/identity/me').set(bearer(token))).status).toBe(200);
    const select = await request(app).post('/api/v1/identity/select-company').set(bearer(token)).send({ companyId });
    expect(select.status).toBe(403);
    expect(select.body.type).toBe('/problems/two_factor_setup_required');
    const staff = await request(app).get('/api/v1/identity/staff').set(bearer(token));
    expect(staff.body.code).toBe('two_factor_setup_required');

    const refreshed = await request(app).post('/api/v1/identity/refresh').set('Cookie', refreshCookie(login));
    expect(refreshed.status).toBe(200);
    expect((await verifyAccessToken(refreshed.body.accessToken)).twoFactorSetupRequired).toBe(true);
    expect((await request(app).post('/api/v1/identity/2fa/setup').set(bearer(token))).status).toBe(200);
    const changed = await request(app)
      .post('/api/v1/identity/change-password')
      .set(bearer(token))
      .send({ currentPassword: PASSWORD, newPassword: 'MatKhauMoi9' });
    expect(changed.status).toBe(204);
    const logout = await request(app).post('/api/v1/identity/logout').set('Cookie', refreshCookie(changed));
    expect(logout.status).toBe(204);
  });

  it('AC-D7: setup trả secret base32 và otpauthUrl, DB chỉ giữ bản mã hoá; confirm sai → 422 errors.code; đúng → 2 mã khôi phục, refresh cho token không còn cờ', async () => {
    const { email } = await registerCompany();
    const login = await loginWithPassword(email);
    const token = login.body.accessToken as string;
    const setup = await request(app).post('/api/v1/identity/2fa/setup').set(bearer(token));
    expect(setup.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.body.otpauthUrl).toBe(
      `otpauth://totp/Commerio:${encodeURIComponent(email)}?secret=${setup.body.secret}&issuer=Commerio`,
    );
    const secret = base32Decode(setup.body.secret);
    const stored = await db.query<{ totp_secret_enc: Buffer; totp_enabled_at: Date | null }>(
      'select totp_secret_enc, totp_enabled_at from staff.accounts where email = $1',
      [email],
    );
    expect(stored.rows[0]!.totp_enabled_at).toBeNull();
    expect(stored.rows[0]!.totp_secret_enc.includes(secret)).toBe(false);

    const wrong = await request(app)
      .post('/api/v1/identity/2fa/confirm')
      .set(bearer(token))
      .send({ code: wrongCode(secret) });
    expect(wrong.status).toBe(422);
    expect(Object.keys(wrong.body.errors)).toEqual(['code']);

    const ok = await request(app)
      .post('/api/v1/identity/2fa/confirm')
      .set(bearer(token))
      .send({ code: totpAt(secret, currentStep()) });
    expect(ok.status).toBe(200);
    expect(ok.body.recoveryCodes).toHaveLength(2);
    for (const code of ok.body.recoveryCodes) expect(code).toMatch(/^[A-Z2-7]{10}$/);
    const hashes = await db.query<{ recovery_code_hashes: string[] }>(
      'select recovery_code_hashes from staff.accounts where email = $1',
      [email],
    );
    expect(hashes.rows[0]!.recovery_code_hashes).toHaveLength(2);
    expect(hashes.rows[0]!.recovery_code_hashes).not.toContain(ok.body.recoveryCodes[0]);

    // Phiên cấp lúc chưa bật 2FA (chỉ qua mật khẩu) bị thu hồi: không refresh ra token không cờ được (review bảo mật
    // [D], C1). Phiên vừa xác nhận nhận cookie mới.
    expect(ok.headers['cache-control']).toBe('no-store');
    const stale = await request(app).post('/api/v1/identity/refresh').set('Cookie', refreshCookie(login));
    expect(stale.status).toBe(401);
    const refreshed = await request(app).post('/api/v1/identity/refresh').set('Cookie', refreshCookie(ok));
    expect(refreshed.status).toBe(200);
    expect((await verifyAccessToken(refreshed.body.accessToken)).twoFactorSetupRequired).toBe(false);
    for (const path of ['setup', 'confirm']) {
      const again = await request(app)
        .post(`/api/v1/identity/2fa/${path}`)
        .set(bearer(refreshed.body.accessToken))
        .send({ code: totpAt(secret, currentStep()) });
      expect(again.status, path).toBe(409);
      expect(again.body.code).toBe('two_factor_already_enabled');
    }
  });

  it('AC-D1: đã bật thì /login trả { mfaRequired, mfaToken }, không access token, không cookie', async () => {
    const { email } = await enrolled();
    const res = await loginWithPassword(email);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['mfaRequired', 'mfaToken']);
    expect(res.body.mfaRequired).toBe(true);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('AC-D2: login/2fa mã đúng → phiên như /login; mã đã dùng hay sai → 401 two_factor_invalid', async () => {
    const { email, secret } = await enrolled();
    const mfaToken = await challenge(email);
    const code = totpAt(secret, currentStep() + 1);
    const ok = await secondFactor({ mfaToken, code });
    expect(ok.status).toBe(200);
    expect(Object.keys(ok.body).sort()).toEqual(['accessToken', 'account', 'memberships']);
    expect(refreshCookie(ok)).toMatch(/^commerio_refresh=/);
    expect((await verifyAccessToken(ok.body.accessToken)).twoFactorSetupRequired).toBe(false);

    const replay = await secondFactor({ mfaToken: await challenge(email), code });
    expect(replay.status).toBe(401);
    expect(replay.body.type).toBe('/problems/two_factor_invalid');
    const wrong = await secondFactor({ mfaToken: await challenge(email), code: wrongCode(secret) });
    expect(wrong.body.code).toBe('two_factor_invalid');
  });

  it('AC-D2: mfaToken sai, là access token, hay quá 5 phút → 401 unauthorized', async () => {
    const { email, secret, token } = await enrolled();
    const account = await db.query<{ id: string }>('select id from staff.accounts where email = $1', [email]);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() - 6 * 60_000);
    const old = await signPurposeToken('mfa', { sub: account.rows[0]!.id });
    vi.useRealTimers();
    for (const mfaToken of ['khong-phai-jwt', token, old]) {
      const res = await secondFactor({ mfaToken, code: totpAt(secret, currentStep() + 1) });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('unauthorized');
    }
  });

  it('login/2fa cần đúng một trong code, recoveryCode → 422', async () => {
    const { email } = await enrolled();
    const mfaToken = await challenge(email);
    expect((await secondFactor({ mfaToken })).status).toBe(422);
    expect((await secondFactor({ mfaToken, code: '123456', recoveryCode: 'ABCDEFGHIJ' })).status).toBe(422);
  });

  it('AC-D3: đăng nhập Google với tài khoản đã bật → cũng mfaRequired', async () => {
    const { email } = await enrolled();
    const res = await request(app)
      .post('/api/v1/identity/google')
      .send({ credential: await googleToken({ email, sub: `g-${randomUUID()}` }) });
    expect(res.status).toBe(200);
    expect(res.body.mfaRequired).toBe(true);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('AC-D4: mã khôi phục dùng được một lần (gõ chữ thường, gạch nối vẫn khớp)', async () => {
    const { email, recoveryCodes } = await enrolled();
    const typed = `${recoveryCodes[0]!.slice(0, 5)}-${recoveryCodes[0]!.slice(5)}`.toLowerCase();
    expect((await secondFactor({ mfaToken: await challenge(email), recoveryCode: typed })).status).toBe(200);
    const again = await secondFactor({ mfaToken: await challenge(email), recoveryCode: recoveryCodes[0] });
    expect(again.status).toBe(401);
    expect(again.body.code).toBe('two_factor_invalid');
    expect((await secondFactor({ mfaToken: await challenge(email), recoveryCode: recoveryCodes[1] })).status).toBe(200);
  });

  it('AC-D5: sai 5 lần trong 15 phút → 429, kể cả lần sau nhập đúng', async () => {
    const { email, secret } = await enrolled();
    const mfaToken = await challenge(email);
    for (let i = 0; i < 5; i++) expect((await secondFactor({ mfaToken, code: wrongCode(secret) })).status).toBe(401);
    const locked = await secondFactor({ mfaToken, code: totpAt(secret, currentStep() + 1) });
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('too_many_requests');
  });

  it('hai login/2fa cùng mã cùng bước: một 200, một 401 two_factor_invalid', async () => {
    const { email, secret } = await enrolled();
    const [a, b] = [await challenge(email), await challenge(email)];
    const code = totpAt(secret, currentStep() + 1);
    const results = await Promise.all([secondFactor({ mfaToken: a, code }), secondFactor({ mfaToken: b, code })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });
});
