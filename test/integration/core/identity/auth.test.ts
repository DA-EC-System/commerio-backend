import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { BUILTIN_ROLES } from '#src/modules/core/access/domain/catalog.ts';
import { CORE_MODULES } from '#src/modules/core/platform/domain/modules.ts';
import { registerBody, registerCompany, uniqueEmail } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { login, PASSWORD, refreshCookie, testApp } from '../../helpers/http.ts';

const app = testApp();
const db = testPool();

const accountId = async (email: string) =>
  (await db.query<{ id: string }>('select id from core.accounts where email = $1', [email])).rows[0]?.id;

describe('đăng ký công ty (UC-PI-01)', () => {
  it('AC-1, 2, 3: tạo công ty, CEO, phân hệ lõi cộng phân hệ đã chọn, nhật ký cấp nền tảng', async () => {
    const { email, companyId } = await registerCompany();
    const account = await db.query('select id, password_hash, must_change_password from core.accounts where email = $1', [email]);
    expect(account.rows[0].password_hash).toMatch(/^\$argon2id\$/);
    expect(account.rows[0].must_change_password).toBe(false);
    const membership = await db.query('select id, status from core.memberships where company_id = $1', [companyId]);
    expect(membership.rows).toEqual([{ id: expect.any(String), status: 'active' }]);
    const roles = await db.query('select role_id from core.member_roles where membership_id = $1', [membership.rows[0].id]);
    expect(roles.rows).toEqual([{ role_id: BUILTIN_ROLES.ceo.id }]);
    const modules = await db.query<{ module_code: string }>(
      'select module_code from core.company_modules where company_id = $1 and enabled',
      [companyId],
    );
    expect(modules.rows.map((m) => m.module_code).sort()).toEqual([...CORE_MODULES, 'purchasing', 'report'].sort());
    const log = await db.query(
      "select company_id, actor_id, action from core.audit_logs where entity_type = 'core.companies' and entity_id = $1",
      [companyId],
    );
    expect(log.rows).toEqual([{ company_id: null, actor_id: account.rows[0].id, action: 'create' }]);
  });

  it('AC-4: dữ liệu sai trả 422 với lỗi theo ô, không tạo gì', async () => {
    const email = 'khong-phai-email';
    const res = await request(app)
      .post('/api/v1/identity/register')
      .send(registerBody(email, { company: { name: '', taxCode: '123' }, ceo: { fullName: 'A B', email, password: 'ngan' } }));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
    expect(Object.keys(res.body.errors)).toEqual(
      expect.arrayContaining(['company.name', 'company.taxCode', 'ceo.email', 'ceo.password']),
    );
  });

  it('AC-5, 19: email đã có tài khoản trả 409 email_taken, không tạo công ty mới', async () => {
    const { email } = await registerCompany();
    // Đếm theo tên riêng của lần đăng ký này: file test khác chạy song song cũng tạo công ty.
    const name = `Công ty trùng email ${uniqueEmail('ten')}`;
    const body = registerBody(email.toUpperCase(), { company: { name, taxCode: '0312345678' } });
    const res = await request(app).post('/api/v1/identity/register').send(body);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('email_taken');
    expect(res.body.errors).toHaveProperty(['ceo.email']);
    const after = await db.query('select count(*)::int as n from core.companies where name = $1', [name]);
    expect(after.rows[0].n).toBe(0);
  });

  it('AC-6: chọn Trợ lý AI mà chưa đồng ý gửi dữ liệu thì 422 errors.assistantDataConsent', async () => {
    const email = uniqueEmail();
    const res = await request(app)
      .post('/api/v1/identity/register')
      .send(registerBody(email, { optionalModules: ['assistant'] }));
    expect(res.status).toBe(422);
    expect(res.body.errors).toHaveProperty('assistantDataConsent');
    expect(await accountId(email)).toBeUndefined();
  });

  it('AC-21: lỗi giữa chừng thì không còn dòng nào của lần đăng ký đó', async () => {
    await db.query(`
      create or replace function core.thu_loi() returns trigger language plpgsql as $$
      begin
        if new.after->>'name' = 'Công ty Gây Lỗi' then raise exception 'lỗi giả'; end if;
        return new;
      end $$;
      drop trigger if exists thu_loi on core.audit_logs;
      create trigger thu_loi before insert on core.audit_logs for each row execute function core.thu_loi();`);
    try {
      const email = uniqueEmail();
      const res = await request(app)
        .post('/api/v1/identity/register')
        .send(registerBody(email, { company: { name: 'Công ty Gây Lỗi', taxCode: '0312345678' } }));
      expect(res.status).toBe(500);
      expect(await accountId(email)).toBeUndefined();
      const companies = await db.query("select 1 from core.companies where name = 'Công ty Gây Lỗi'");
      expect(companies.rowCount).toBe(0);
    } finally {
      await db.query('drop trigger if exists thu_loi on core.audit_logs; drop function if exists core.thu_loi();');
    }
  });
});

describe('đăng nhập (UC-PI-03)', () => {
  it('AC-7: trả token, tài khoản, công ty; refresh token trong cookie HttpOnly, DB chỉ lưu bản băm', async () => {
    const { email, companyId } = await registerCompany();
    const res = await request(app).post('/api/v1/identity/login').send({ email: ` ${email.toUpperCase()} `, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.account).toMatchObject({ email, mustChangePassword: false, isPlatformAdmin: false });
    expect(res.body.account).not.toHaveProperty('passwordHash');
    expect(res.body.memberships).toEqual([
      { companyId, companyName: 'Công ty Thử Nghiệm', companyStatus: 'active', status: 'active', roles: ['CEO'] },
    ]);
    const setCookie = ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith('commerio_refresh='))!;
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    const raw = refreshCookie(res).split('=')[1]!;
    const stored = await db.query('select 1 from core.refresh_tokens where token_hash = $1', [raw]);
    expect(stored.rowCount).toBe(0);
    const payload = JSON.parse(Buffer.from(res.body.accessToken.split('.')[1], 'base64url').toString());
    expect(payload.exp - payload.iat).toBe(15 * 60);
  });

  it('AC-8, 17: sai mật khẩu và email không tồn tại trả cùng một lỗi 401 invalid_credentials', async () => {
    const { email } = await registerCompany();
    const wrong = await request(app).post('/api/v1/identity/login').send({ email, password: 'SaiMatKhau1' });
    const missing = await request(app).post('/api/v1/identity/login').send({ email: uniqueEmail(), password: PASSWORD });
    for (const res of [wrong, missing]) {
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('invalid_credentials');
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    expect(wrong.body.detail).toBe(missing.body.detail);
  });
});

describe('chọn công ty', () => {
  it('AC-9: token gắn công ty; quyền của phân hệ chưa bật bị bỏ', async () => {
    const { email, companyId } = await registerCompany(uniqueEmail(), { optionalModules: [] });
    const { token } = await login(email);
    const res = await request(app)
      .post('/api/v1/identity/select-company')
      .set('Authorization', `Bearer ${token}`)
      .send({ companyId });
    expect(res.status).toBe(200);
    expect(res.body.context).toMatchObject({ companyId, roles: ['CEO'] });
    expect(res.body.context.enabledModules.sort()).toEqual([...CORE_MODULES].sort());
    expect(res.body.context.permissions).toContain('catalog.product.manage');
    expect(res.body.context.permissions.some((p: string) => p.startsWith('purchasing.'))).toBe(false);
    const payload = JSON.parse(Buffer.from(res.body.accessToken.split('.')[1], 'base64url').toString());
    expect(payload.cid).toBe(companyId);
  });

  it('AC-10, 18: công ty khoá 403 company_locked, tài khoản khoá 403 account_locked; login vẫn 200', async () => {
    const locked = await registerCompany();
    const suspended = await registerCompany();
    await db.query("update core.companies set status = 'locked' where id = $1", [locked.companyId]);
    await db.query("update core.memberships set status = 'suspended' where company_id = $1", [suspended.companyId]);

    const a = await login(locked.email);
    expect(a.body.memberships[0]).toMatchObject({ companyStatus: 'locked', status: 'active' });
    const resA = await request(app)
      .post('/api/v1/identity/select-company')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ companyId: locked.companyId });
    expect(resA.status).toBe(403);
    expect(resA.body.code).toBe('company_locked');

    const b = await login(suspended.email);
    expect(b.body.memberships[0]).toMatchObject({ companyStatus: 'active', status: 'locked' });
    const resB = await request(app)
      .post('/api/v1/identity/select-company')
      .set('Authorization', `Bearer ${b.token}`)
      .send({ companyId: suspended.companyId });
    expect(resB.status).toBe(403);
    expect(resB.body.code).toBe('account_locked');
  });

  it('công ty mình không thuộc trả 404 not_found; thiếu token trả 401', async () => {
    const mine = await registerCompany();
    const other = await registerCompany();
    const { token } = await login(mine.email);
    const res = await request(app)
      .post('/api/v1/identity/select-company')
      .set('Authorization', `Bearer ${token}`)
      .send({ companyId: other.companyId });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
    const noToken = await request(app).post('/api/v1/identity/select-company').send({ companyId: mine.companyId });
    expect(noToken.status).toBe(401);
    expect(noToken.body.code).toBe('unauthorized');
  });
});

describe('refresh và đăng xuất', () => {
  it('AC-11: refresh cấp token mới, giữ công ty đã chọn; cookie cũ hết hiệu lực; thiếu cookie 401', async () => {
    const { email, companyId } = await registerCompany();
    const { token, cookie } = await login(email);
    await request(app)
      .post('/api/v1/identity/select-company')
      .set('Authorization', `Bearer ${token}`)
      .set('Cookie', cookie)
      .send({ companyId });
    const res = await request(app).post('/api/v1/identity/refresh').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const payload = JSON.parse(Buffer.from(res.body.accessToken.split('.')[1], 'base64url').toString());
    expect(payload.cid).toBe(companyId);
    expect(refreshCookie(res)).not.toBe(cookie);

    const reused = await request(app).post('/api/v1/identity/refresh').set('Cookie', cookie);
    expect(reused.status).toBe(401);
    const missing = await request(app).post('/api/v1/identity/refresh');
    expect(missing.status).toBe(401);
    expect(missing.body.code).toBe('unauthorized');
  });

  it('AC-12: đăng xuất thu hồi refresh token và xoá cookie', async () => {
    const { email } = await registerCompany();
    const { cookie } = await login(email);
    const out = await request(app).post('/api/v1/identity/logout').set('Cookie', cookie);
    expect(out.status).toBe(204);
    expect(String(out.headers['set-cookie'])).toMatch(/commerio_refresh=;/);
    const res = await request(app).post('/api/v1/identity/refresh').set('Cookie', cookie);
    expect(res.status).toBe(401);
  });
});

describe('mật khẩu thư mời và đổi mật khẩu (UC-PI-04)', () => {
  it('AC-13, 20: còn mật khẩu thư mời thì đăng nhập được, chỉ gọi được me và đổi mật khẩu', async () => {
    const { email, companyId } = await registerCompany();
    await db.query('update core.accounts set must_change_password = true where email = $1', [email]);
    const { token, body } = await login(email);
    expect(body.account.mustChangePassword).toBe(true);
    const select = await request(app)
      .post('/api/v1/identity/select-company')
      .set('Authorization', `Bearer ${token}`)
      .send({ companyId });
    expect(select.status).toBe(403);
    expect(select.body.code).toBe('password_change_required');
    const me = await request(app).get('/api/v1/identity/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.account.email).toBe(email);
  });

  it('AC-14, 20: đổi mật khẩu trả 204, bỏ cờ, ghi nhật ký cấp tài khoản; mật khẩu cũ hết dùng được', async () => {
    const { email } = await registerCompany();
    await db.query('update core.accounts set must_change_password = true where email = $1', [email]);
    const { token } = await login(email);
    const res = await request(app)
      .post('/api/v1/identity/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: PASSWORD, newPassword: 'MatKhauMoi456' });
    expect(res.status).toBe(204);
    const id = await accountId(email);
    const account = await db.query('select must_change_password from core.accounts where id = $1', [id]);
    expect(account.rows[0].must_change_password).toBe(false);
    const log = await db.query("select company_id from core.audit_logs where entity_type = 'core.accounts' and entity_id = $1", [id]);
    expect(log.rows).toEqual([{ company_id: null }]);
    const old = await request(app).post('/api/v1/identity/login').send({ email, password: PASSWORD });
    expect(old.status).toBe(401);
    await login(email, 'MatKhauMoi456');
  });

  it('AC-15: mật khẩu hiện tại sai hoặc mật khẩu mới không đạt quy tắc trả 422 theo ô', async () => {
    const { email } = await registerCompany();
    const { token } = await login(email);
    const wrong = await request(app)
      .post('/api/v1/identity/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'SaiMatKhau1', newPassword: 'MatKhauMoi456' });
    expect(wrong.status).toBe(422);
    expect(wrong.body.errors).toHaveProperty('currentPassword');
    const weak = await request(app)
      .post('/api/v1/identity/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: PASSWORD, newPassword: 'chiCoChu' });
    expect(weak.status).toBe(422);
    expect(weak.body.errors).toHaveProperty('newPassword');
    await login(email);
  });
});
