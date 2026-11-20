// Đăng ký công ty hai bước (#459, Documents/21 mục 2.1): gửi form → mã email → nhập mã thì vào thẳng công ty.
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { registrationOtpHash } from '#src/modules/core/identity/domain/registration.ts';
import { handleRegistrationMail, runRegistrationPurge } from '#src/modules/core/identity/index.ts';
import { CORE_MODULES } from '#src/modules/core/platform/domain/modules.ts';
import { type MailTransport, setMailTransport } from '#src/shared/mail/index.ts';
import {
  KNOWN_REGISTRATION_CODE,
  registerBody,
  registerCompany,
  startRegistration,
  uniqueEmail,
  uniqueTaxCode,
} from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { refreshCookie, testApp } from '../../helpers/http.ts';

const app = testApp();
const db = testPool();
const TEST_CODE = '246810'; // REGISTRATION_TEST_CODE trong vitest.config.ts
const testEmail = () => `e2e-${crypto.randomUUID()}@dang-ky.test`;

type SentMail = Parameters<MailTransport['sendMail']>[0];
function captureMail(): SentMail[] {
  const sent: SentMail[] = [];
  setMailTransport({
    sendMail: async (message) => {
      sent.push(message);
      return {};
    },
  });
  return sent;
}
afterEach(() => setMailTransport(null));

const register = (body: object) => request(app).post('/api/v1/identity/register').send(body);
const verify = (registrationId: string, code: string) =>
  request(app).post('/api/v1/identity/register/verify').send({ registrationId, code });
const resend = (registrationId: string) => request(app).post('/api/v1/identity/register/resend').send({ registrationId });

async function row(id: string) {
  const { rows } = await db.query('select * from core.registrations where id = $1', [id]);
  return rows[0];
}
async function mailJob(id: string) {
  const r = await row(id);
  return { registrationId: id, requestedAt: (r.otp_requested_at as Date).toISOString() };
}

describe('POST /identity/register (bước 1)', () => {
  it('202 RegistrationStatus; lưu mật khẩu đã băm, chưa có mã; chưa tạo tài khoản, công ty', async () => {
    const email = uniqueEmail();
    const res = await register(registerBody(email));
    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      registrationId: expect.any(String),
      codeExpiresAt: expect.any(String),
      registrationExpiresAt: expect.any(String),
      resendAfterSeconds: 60,
    });
    const saved = await row(res.body.registrationId);
    expect(saved.password_hash).toMatch(/^\$argon2id\$/);
    expect(saved.otp_hash).toBeNull();
    expect(Date.parse(res.body.registrationExpiresAt) - Date.parse(res.body.codeExpiresAt)).toBe(25 * 60_000);
    const accounts = await db.query('select 1 from core.accounts where email = $1', [email]);
    expect(accounts.rowCount).toBe(0);
  });

  it('email đã có tài khoản: cùng 202 như email mới, không lộ gì', async () => {
    const { email } = await registerCompany();
    const res = await register(registerBody(email));
    expect(res.status).toBe(202);
    expect(Object.keys(res.body).sort()).toEqual(['codeExpiresAt', 'registrationExpiresAt', 'registrationId', 'resendAfterSeconds']);
  });

  it('mã số thuế đã có công ty: 409 tax_code_taken; sai định dạng 422 errors["company.taxCode"]', async () => {
    const taxCode = uniqueTaxCode();
    await registerCompany(uniqueEmail(), { company: { name: 'Công ty có MST', taxCode } });
    const taken = await register(registerBody(uniqueEmail(), { company: { name: 'Công ty khác', taxCode: ` ${taxCode}` } }));
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('tax_code_taken');
    const bad = await register(registerBody(uniqueEmail(), { company: { name: 'Công ty sai MST', taxCode: '123' } }));
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toHaveProperty(['company.taxCode']);
  });

  it('trần theo email: lần thứ tư khi còn 3 đăng ký còn hạn thì 429', async () => {
    const email = uniqueEmail();
    for (let i = 0; i < 3; i++) expect((await register(registerBody(email))).status).toBe(202);
    const res = await register(registerBody(email));
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('too_many_requests');
  });
});

describe('việc nền gửi thư đăng ký', () => {
  it('email mới: ghi bản băm của mã, gửi thư có tên công ty, câu cảnh báo và mã đó', async () => {
    const sent = captureMail();
    const res = await register(registerBody(uniqueEmail(), { company: { name: 'Công ty Thư Mã', taxCode: uniqueTaxCode() } }));
    await handleRegistrationMail(await mailJob(res.body.registrationId));
    expect(sent).toHaveLength(1);
    const text = String(sent[0]!.text);
    expect(text).toContain('Công ty Thư Mã');
    expect(text).toContain('Đừng đưa mã cho ai');
    const code = /là: (\d{6})/.exec(text)![1]!;
    expect((await row(res.body.registrationId)).otp_hash).toBe(registrationOtpHash(code, res.body.registrationId));
    expect((await verify(res.body.registrationId, code)).status).toBe(201);
  });

  it('email đã có tài khoản: thư báo không có mã, tối đa một thư mỗi 24 giờ; mọi mã đều 422', async () => {
    const { email } = await registerCompany();
    const sent = captureMail();
    const first = await register(registerBody(email));
    await handleRegistrationMail(await mailJob(first.body.registrationId));
    const second = await register(registerBody(email));
    await handleRegistrationMail(await mailJob(second.body.registrationId));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toContain('đã có tài khoản');
    expect(String(sent[0]!.text)).not.toMatch(/\d{6}/);
    expect((await row(first.body.registrationId)).otp_hash).toBeNull();
    const res = await verify(first.body.registrationId, KNOWN_REGISTRATION_CODE);
    expect(res.status).toBe(422);
    expect(res.body.errors).toHaveProperty('code');
  });

  it('việc cũ hơn 5 phút hoặc của lần xin trước thì bỏ, không gửi thư', async () => {
    const sent = captureMail();
    const res = await register(registerBody(uniqueEmail()));
    await handleRegistrationMail({ registrationId: res.body.registrationId, requestedAt: new Date(Date.now() - 6 * 60_000).toISOString() });
    await handleRegistrationMail({ registrationId: res.body.registrationId, requestedAt: new Date(Date.now() - 1000).toISOString() });
    expect(sent).toHaveLength(0);
    expect((await row(res.body.registrationId)).otp_hash).toBeNull();
  });

  it('miền thử e2e: mã cố định đi chung đường kiểm, không gửi thư; nhật ký ghi testRegistration', async () => {
    const sent = captureMail();
    const res = await register(registerBody(testEmail()));
    await handleRegistrationMail(await mailJob(res.body.registrationId));
    expect(sent).toHaveLength(0);
    expect((await verify(res.body.registrationId, '000000')).status).toBe(422);
    expect((await row(res.body.registrationId)).otp_attempts).toBe(1);
    const ok = await verify(res.body.registrationId, TEST_CODE);
    expect(ok.status).toBe(201);
    expect(JSON.stringify(ok.body)).not.toContain(TEST_CODE);
    const log = await db.query(
      "select after from core.audit_logs where entity_type = 'core.companies' and entity_id = $1",
      [ok.body.context.companyId],
    );
    expect(log.rows[0].after.testRegistration).toBe(true);
  });
});

describe('POST /identity/register/verify (bước 2)', () => {
  it('201: phiên gắn công ty mới (cid), cookie refresh, no-store; phân hệ lõi + Nhập hàng; dòng đăng ký bị xoá', async () => {
    const email = uniqueEmail();
    const id = await startRegistration(email);
    const res = await verify(id, KNOWN_REGISTRATION_CODE);
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(refreshCookie(res)).toMatch(/^commerio_refresh=/);
    const { companyId } = res.body.context;
    const payload = JSON.parse(Buffer.from(res.body.accessToken.split('.')[1], 'base64url').toString());
    expect(payload.cid).toBe(companyId);
    expect(res.body.account).toMatchObject({ email });
    expect(res.body.memberships).toEqual([expect.objectContaining({ companyId, roles: ['CEO'] })]);
    expect([...res.body.context.enabledModules].sort()).toEqual([...CORE_MODULES, 'purchasing'].sort());
    expect(await row(id)).toBeUndefined();
    const me = await request(app).get('/api/v1/identity/me').set('Authorization', `Bearer ${res.body.accessToken}`);
    expect(me.status).toBe(200);
    expect((await verify(id, KNOWN_REGISTRATION_CODE)).status).toBe(410);
  });

  it('mã sai: 422 errors.code, đếm sai dù lỗi; sai 5 lần thì mã đúng cũng 422', async () => {
    const id = await startRegistration();
    for (let i = 1; i <= 5; i++) {
      const res = await verify(id, '000000');
      expect(res.status).toBe(422);
      expect(res.body.errors).toHaveProperty('code');
      expect((await row(id)).otp_attempts).toBe(i);
    }
    expect((await verify(id, KNOWN_REGISTRATION_CODE)).status).toBe(422);
  });

  it('mã quá 5 phút: 422; lần đăng ký quá 30 phút hay id lạ: 410 registration_expired', async () => {
    const id = await startRegistration();
    await db.query("update core.registrations set otp_expires_at = now() - interval '1 second' where id = $1", [id]);
    expect((await verify(id, KNOWN_REGISTRATION_CODE)).status).toBe(422);
    await db.query("update core.registrations set expires_at = now() - interval '1 second' where id = $1", [id]);
    const res = await verify(id, KNOWN_REGISTRATION_CODE);
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('registration_expired');
    expect((await verify(crypto.randomUUID(), KNOWN_REGISTRATION_CODE)).status).toBe(410);
  });

  it('hai lần nhập đúng mã cùng lúc: một 201, một 410; chỉ một công ty', async () => {
    const id = await startRegistration();
    const results = await Promise.all([verify(id, KNOWN_REGISTRATION_CODE), verify(id, KNOWN_REGISTRATION_CODE)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 410]);
  });

  it('email vừa có tài khoản trong lúc chờ mã: 409 email_taken, dòng đăng ký bị xoá', async () => {
    const email = uniqueEmail();
    const first = await startRegistration(email);
    const second = await startRegistration(email);
    expect((await verify(first, KNOWN_REGISTRATION_CODE)).status).toBe(201);
    const res = await verify(second, KNOWN_REGISTRATION_CODE);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('email_taken');
    expect(await row(second)).toBeUndefined();
  });

  it('công ty khác vừa đăng ký cùng mã số thuế: 409 tax_code_taken, dòng đăng ký bị xoá', async () => {
    const taxCode = uniqueTaxCode();
    const a = await startRegistration(uniqueEmail(), { company: { name: 'Công ty A', taxCode } });
    const b = await startRegistration(uniqueEmail(), { company: { name: 'Công ty B', taxCode } });
    expect((await verify(a, KNOWN_REGISTRATION_CODE)).status).toBe(201);
    const res = await verify(b, KNOWN_REGISTRATION_CODE);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('tax_code_taken');
    expect(await row(b)).toBeUndefined();
  });
});

describe('POST /identity/register/resend', () => {
  it('chưa qua 60 giây: 429 kèm Retry-After; qua rồi: 202, mã cũ mất hiệu lực, đặt lại bộ đếm sai', async () => {
    const id = await startRegistration();
    const early = await resend(id);
    expect(early.status).toBe(429);
    expect(Number(early.headers['retry-after'])).toBeGreaterThan(0);
    await verify(id, '000000');
    await db.query("update core.registrations set otp_requested_at = now() - interval '61 seconds' where id = $1", [id]);
    const res = await resend(id);
    expect(res.status).toBe(202);
    expect(res.body.resendAfterSeconds).toBe(60);
    const saved = await row(id);
    expect(saved).toMatchObject({ otp_hash: null, otp_attempts: 0, otp_send_count: 2 });
    expect((await verify(id, KNOWN_REGISTRATION_CODE)).status).toBe(422);
  });

  it('đã gửi đủ 5 thư: 429 otp_send_limit; lần đăng ký hết hạn: 410', async () => {
    const id = await startRegistration();
    await db.query(
      "update core.registrations set otp_send_count = 5, otp_requested_at = now() - interval '61 seconds', created_at = now() - interval '2 hours' where id = $1",
      [id],
    );
    const res = await resend(id);
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('otp_send_limit');
    await db.query("update core.registrations set expires_at = now() - interval '1 second' where id = $1", [id]);
    expect((await resend(id)).status).toBe(410);
  });
});

describe('dọn lần đăng ký cũ', () => {
  it('xoá dòng tạo quá 24 giờ, giữ dòng mới', async () => {
    const old = await startRegistration();
    const fresh = await startRegistration();
    await db.query("update core.registrations set created_at = now() - interval '25 hours' where id = $1", [old]);
    expect(await runRegistrationPurge()).toBeGreaterThanOrEqual(1);
    expect(await row(old)).toBeUndefined();
    expect(await row(fresh)).toBeDefined();
  });
});
