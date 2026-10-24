import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

// Quản trị nền tảng đặt lại 2FA (#7 [D], AC-D10), chạy với 2FA bắt buộc.
vi.hoisted(() => {
  process.env.TWO_FACTOR_MODE = 'required';
});

const { enableTotp, saveTotpSecret } = await import('#src/modules/staff/repository/accounts.ts');
const { sealTotpSecret } = await import('#src/modules/staff/service/totp-secrets.ts');
const { verifyAccessToken } = await import('#src/shared/auth/jwt.ts');
const { hashPassword } = await import('#src/shared/crypto/password.ts');
const { TOTP_STEP_SECONDS, totpAt } = await import('#src/shared/crypto/totp.ts');
const { registerCompany, uniqueEmail } = await import('../helpers/company.ts');
const { testPool } = await import('../helpers/db.ts');
const { PASSWORD, refreshCookie, testApp } = await import('../helpers/http.ts');

const app = testApp();
const db = testPool();
const RAW = Buffer.from('12345678901234567890');
const currentStep = () => Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);

async function enable2fa(accountId: string) {
  expect(await saveTotpSecret(accountId, sealTotpSecret(RAW, accountId))).toBe(true);
  expect(await enableTotp(accountId, currentStep() - 5, ['bam-a'])).toBe(true);
}

/** Đăng nhập tài khoản đã bật 2FA bằng mật khẩu rồi mã hiện tại; trả phản hồi của `/login/2fa`. */
async function loginWith2fa(email: string) {
  const first = await request(app).post('/api/v1/identity/login').send({ email, password: PASSWORD });
  expect(first.body.mfaRequired).toBe(true);
  const res = await request(app)
    .post('/api/v1/identity/login/2fa')
    .send({ mfaToken: first.body.mfaToken, code: totpAt(RAW, currentStep()) });
  expect(res.status).toBe(200);
  return res;
}

async function platformAdminToken(): Promise<string> {
  const email = uniqueEmail('quan-tri');
  const res = await db.query<{ id: string }>(
    "insert into staff.accounts (email, full_name, password_hash, is_platform_admin) values ($1, 'Quản Trị', $2, true) returning id",
    [email, await hashPassword(PASSWORD)],
  );
  await enable2fa(res.rows[0]!.id);
  return (await loginWith2fa(email)).body.accessToken as string;
}

/** CEO đã bật 2FA, đang có một phiên (cookie refresh). */
async function enrolledCeo() {
  const { email, companyId } = await registerCompany();
  const id = (await db.query<{ id: string }>('select id from staff.accounts where email = $1', [email])).rows[0]!.id;
  await enable2fa(id);
  const session = await loginWith2fa(email);
  return { id, email, companyId, token: session.body.accessToken as string, cookie: refreshCookie(session) };
}

const reset = (accountId: string, token?: string) => {
  const req = request(app).post(`/api/v1/platform/accounts/${accountId}/2fa/reset`);
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
};

describe('đặt lại 2FA', () => {
  it('AC-D10: quản trị nền tảng reset → xoá 2FA và mã khôi phục, thu hồi refresh token, lần sau phải thiết lập lại, nhật ký cấp nền tảng; gọi lại vẫn 204', async () => {
    const admin = await platformAdminToken();
    const target = await enrolledCeo();
    const res = await reset(target.id, admin);
    expect(res.status).toBe(204);
    const row = await db.query(
      'select totp_secret_enc, totp_enabled_at, totp_last_step, recovery_code_hashes from staff.accounts where id = $1',
      [target.id],
    );
    expect(row.rows[0]).toEqual({
      totp_secret_enc: null,
      totp_enabled_at: null,
      totp_last_step: null,
      recovery_code_hashes: [],
    });
    expect((await request(app).post('/api/v1/identity/refresh').set('Cookie', target.cookie)).status).toBe(401);

    const login = await request(app).post('/api/v1/identity/login').send({ email: target.email, password: PASSWORD });
    expect(login.body.mfaRequired).toBeUndefined();
    expect((await verifyAccessToken(login.body.accessToken)).twoFactorSetupRequired).toBe(true);

    const audit = await db.query(
      "select company_id, action, after from audit.audit_logs where entity_type = 'staff.accounts' and entity_id = $1",
      [target.id],
    );
    expect(audit.rows).toEqual([{ company_id: null, action: 'update', after: { twoFactorReset: true } }]);
    expect((await reset(target.id, admin)).status).toBe(204);
  });

  it('Admin, CEO công ty gọi → 403 forbidden; không token → 401; accountId sai dạng hay không có → 404', async () => {
    const admin = await platformAdminToken();
    const ceo = await enrolledCeo();
    const other = await enrolledCeo();
    const forbidden = await reset(other.id, ceo.token);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe('forbidden');
    expect((await reset(other.id)).status).toBe(401);
    for (const id of ['khong-phai-uuid', randomUUID()]) {
      const res = await reset(id, admin);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_found');
    }
    const still = await db.query('select totp_enabled_at from staff.accounts where id = $1', [other.id]);
    expect(still.rows[0].totp_enabled_at).not.toBeNull();
  });
});
