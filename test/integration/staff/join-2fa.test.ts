import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

// 2FA trong luồng tham gia (#7 [D], AC-D8, AC-D9): chạy với 2FA bắt buộc.
vi.hoisted(() => {
  process.env.TWO_FACTOR_MODE = 'required';
});

const { BUILTIN_ROLES } = await import('#src/modules/access/domain/catalog.ts');
const { enableTotp, saveTotpSecret } = await import('#src/modules/staff/repository/accounts.ts');
const { openTotpSecret, sealTotpSecret } = await import('#src/modules/staff/service/totp-secrets.ts');
const { setMailTransport } = await import('#src/shared/mail/index.ts');
const { base32Decode, TOTP_STEP_SECONDS, totpAt } = await import('#src/shared/crypto/totp.ts');
const { registerCompany, uniqueEmail } = await import('../helpers/company.ts');
const { accountIdOf } = await import('./helpers.ts');
const { testPool } = await import('../helpers/db.ts');
const { PASSWORD, testApp } = await import('../helpers/http.ts');
const { captureMail, codeIn, deliverOtp, joinApi, newLink } = await import('./helpers.ts');

const app = testApp();
const db = testPool();
const join = joinApi(app);
const NEW_PASSWORD = 'MatKhauMoi9';
const currentStep = () => Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
const post = (path: string, body: object) => request(app).post(`/api/v1/identity/${path}`).send(body);

afterEach(() => setMailTransport(null));

const RAW = Buffer.from('12345678901234567890');

/** Bật 2FA cho tài khoản bằng secret cố định, bước đã dùng lùi 5 bước để mã hiện tại còn dùng được. */
async function enable2fa(accountId: string) {
  expect(await saveTotpSecret(accountId, sealTotpSecret(RAW, accountId))).toBe(true);
  expect(await enableTotp(accountId, currentStep() - 5, [])).toBe(true);
}

/**
 * Công ty mới kèm token CEO đã chọn công ty. Helper `createCompany` chọn công ty bằng token còn cờ `tfs` nên không
 * dùng được khi 2FA bắt buộc: CEO bật 2FA rồi đăng nhập qua `/login/2fa`.
 */
async function companyWithCeo() {
  const { email, companyId } = await registerCompany();
  await enable2fa(await accountIdOf(email));
  const login = await post('login', { email, password: PASSWORD });
  const session = await post('login/2fa', { mfaToken: login.body.mfaToken, code: totpAt(RAW, currentStep()) });
  const selected = await request(app)
    .post('/api/v1/identity/select-company')
    .set('Authorization', `Bearer ${session.body.accessToken}`)
    .send({ companyId });
  expect(selected.status).toBe(200);
  return { companyId, ceo: { token: selected.body.accessToken as string } };
}

let company: Awaited<ReturnType<typeof companyWithCeo>>;

async function claimed(email: string) {
  company ??= await companyWithCeo();
  const sent = captureMail();
  const link = await newLink(app, company.ceo.token, [BUILTIN_ROLES.sale.id]);
  expect((await join.otp(link.token, email)).status).toBe(202);
  await deliverOtp(link.id);
  const verified = await join.verify(link.token, email, codeIn(sent.at(-1)!));
  expect(verified.status).toBe(200);
  return { ...link, registrationToken: verified.body.registrationToken as string, next: verified.body.next as string };
}

describe('2FA lúc tham gia qua link', () => {
  it('AC-D8: email mới chưa xác nhận 2FA → complete 422 errors.totpCode; thiết lập xong thì nộp được, duyệt xong tài khoản có 2FA bật sẵn', async () => {
    const email = uniqueEmail('moi-2fa');
    const c = await claimed(email);
    const body = { registrationToken: c.registrationToken, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD };
    const early = await join.complete(body);
    expect(early.status).toBe(422);
    expect(Object.keys(early.body.errors)).toEqual(['totpCode']);

    const setup = await post('join/2fa/setup', { registrationToken: c.registrationToken });
    expect(setup.status).toBe(200);
    expect(setup.body.otpauthUrl).toContain(encodeURIComponent(email));
    const secret = base32Decode(setup.body.secret);
    const wrong = await post('join/2fa/confirm', {
      registrationToken: c.registrationToken,
      code: '000000' === totpAt(secret, currentStep()) ? '111111' : '000000',
    });
    expect(wrong.status).toBe(422);
    expect(Object.keys(wrong.body.errors)).toEqual(['code']);
    const confirmed = await post('join/2fa/confirm', {
      registrationToken: c.registrationToken,
      code: totpAt(secret, currentStep()),
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.recoveryCodes).toHaveLength(2);
    expect((await join.complete(body)).body).toEqual({ status: 'pending' });
    // Đã nộp thì không thiết lập lại được.
    expect((await post('join/2fa/setup', { registrationToken: c.registrationToken })).body.code).toBe(
      'invitation_used',
    );

    const inv = await db.query<{ version: number }>('select version from staff.invitations where id = $1', [c.id]);
    const approved = await request(app)
      .post(`/api/v1/identity/invitations/${c.id}/approve`)
      .set('Authorization', `Bearer ${company.ceo.token}`)
      .send({ version: inv.rows[0]!.version });
    expect(approved.status).toBe(200);
    const account = await db.query<{
      id: string;
      totp_secret_enc: Buffer;
      totp_enabled_at: Date | null;
      recovery_code_hashes: string[];
    }>('select id, totp_secret_enc, totp_enabled_at, recovery_code_hashes from staff.accounts where email = $1', [
      email,
    ]);
    const row = account.rows[0]!;
    expect(row.totp_enabled_at).not.toBeNull();
    expect(row.recovery_code_hashes).toHaveLength(2);
    expect(openTotpSecret(row.totp_secret_enc, row.id)).toEqual(secret);
    const cleaned = await db.query(
      'select totp_secret_enc, recovery_code_hashes from staff.invitations where id = $1',
      [c.id],
    );
    expect(cleaned.rows[0]).toEqual({ totp_secret_enc: null, recovery_code_hashes: [] });

    // Nhân viên đăng nhập phải qua mã sinh từ secret đã quét lúc đăng ký.
    const login = await post('login', { email, password: NEW_PASSWORD });
    expect(login.body.mfaRequired).toBe(true);
    const session = await post('login/2fa', { mfaToken: login.body.mfaToken, code: totpAt(secret, currentStep() + 1) });
    expect(session.status).toBe(200);
  });

  it('AC-D9: tài khoản đã có, đã bật 2FA → complete thiếu hay sai totpCode → 422 errors.totpCode; đúng thì pending', async () => {
    // CEO của công ty khác: tài khoản đã có.
    const known = await registerCompany();
    await enable2fa(await accountIdOf(known.email));
    const raw = RAW;
    const c = await claimed(known.email);
    expect(c.next).toBe('sign_in');
    const missing = await join.complete({ registrationToken: c.registrationToken, password: PASSWORD });
    expect(missing.status).toBe(422);
    expect(Object.keys(missing.body.errors)).toEqual(['totpCode']);
    const wrongCode = totpAt(raw, currentStep()) === '000000' ? '111111' : '000000';
    const wrong = await post('join/complete', {
      registrationToken: c.registrationToken,
      password: PASSWORD,
      totpCode: wrongCode,
    });
    expect(Object.keys(wrong.body.errors)).toEqual(['totpCode']);
    const ok = await post('join/complete', {
      registrationToken: c.registrationToken,
      password: PASSWORD,
      totpCode: totpAt(raw, currentStep()),
    });
    expect(ok.body).toEqual({ status: 'pending' });
  });

  it('tài khoản đã có chưa bật 2FA: nộp không cần mã (thiết lập ở lần đăng nhập sau); join/2fa/* chỉ cho email mới', async () => {
    const known = await registerCompany();
    const c = await claimed(known.email);
    const setup = await post('join/2fa/setup', { registrationToken: c.registrationToken });
    expect(setup.status).toBe(422);
    expect(Object.keys(setup.body.errors)).toEqual(['registrationToken']);
    expect((await join.complete({ registrationToken: c.registrationToken, password: PASSWORD })).body).toEqual({
      status: 'pending',
    });
  });

  it('registrationToken sai → 410 registration_expired ở join/2fa/*', async () => {
    for (const path of ['join/2fa/setup', 'join/2fa/confirm']) {
      const res = await post(path, { registrationToken: 'khong-phai-jwt', code: '123456' });
      expect(res.status, path).toBe(410);
      expect(res.body.code).toBe('registration_expired');
    }
  });
});
