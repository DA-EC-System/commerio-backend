import { randomUUID } from 'node:crypto';
import { errors } from 'jose';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { BUILTIN_ROLES } from '#src/modules/core/access/domain/catalog.ts';
import { setGoogleKeySource } from '#src/modules/core/identity/service/google.ts';
import { addMember, createCompany, registerCompany, uniqueEmail } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { refreshCookie, testApp } from '../../helpers/http.ts';
import { raceBehindLock } from '../../helpers/locks.ts';
import { lockCompany, suspendMembership } from '../../helpers/state.ts';
import { useFakeGoogle } from './helpers.ts';

const app = testApp();
const db = testPool();
const { googleToken, restoreKeys } = useFakeGoogle();

const google = (credential: string) => request(app).post('/api/v1/identity/google').send({ credential });
const selectCompany = (token: string, companyId: string) =>
  request(app).post('/api/v1/identity/select-company').set('Authorization', `Bearer ${token}`).send({ companyId });
const account = async (email: string) =>
  (await db.query<{ id: string; google_sub: string | null }>('select id, google_sub from staff.accounts where email = $1', [email]))
    .rows[0]!;
const linkLogs = (accountId: string) =>
  db.query(
    "select action, after from audit.audit_logs where entity_type = 'staff.accounts' and entity_id = $1 and company_id is null",
    [accountId],
  );

// Đăng nhập Google cho tài khoản đã có (#7 [A], spec 5.1, AC-A1..A6).
describe('đăng nhập Google', () => {
  it('AC-A1: liên kết lần đầu theo email, trả như /login, ghi google_sub và một dòng nhật ký', async () => {
    const { email } = await registerCompany();
    const sub = `g-${randomUUID()}`;
    const res = await google(await googleToken({ email, sub }));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['accessToken', 'account', 'memberships']);
    expect(res.body.memberships).toHaveLength(1);
    expect(refreshCookie(res)).toMatch(/^commerio_refresh=/);
    expect(String(res.headers['set-cookie'])).toMatch(/HttpOnly; Secure; SameSite=Strict/);
    const row = await account(email);
    expect(row.google_sub).toBe(sub);
    expect((await linkLogs(row.id)).rows).toEqual([{ action: 'update', after: { googleLinked: true } }]);
  });

  it('email trong token viết hoa vẫn khớp tài khoản', async () => {
    const { email } = await registerCompany();
    expect((await google(await googleToken({ email: email.toUpperCase(), sub: `g-${randomUUID()}` }))).status).toBe(200);
  });

  it('AC-A2: đã liên kết sub thì đăng nhập đúng tài khoản dù email trong token đã đổi, không ghi nhật ký lần nữa', async () => {
    const { email } = await registerCompany();
    const sub = `g-${randomUUID()}`;
    expect((await google(await googleToken({ email, sub }))).status).toBe(200);
    const res = await google(await googleToken({ email: uniqueEmail('doi-email'), sub }));
    expect(res.status).toBe(200);
    expect(res.body.account.email).toBe(email);
    expect((await linkLogs((await account(email)).id)).rows).toHaveLength(1);
  });

  it('AC-A3: email không có tài khoản → 401 google_account_not_found, không tạo tài khoản', async () => {
    // Đếm theo email và sub của chính test: file khác chạy song song cũng tạo tài khoản.
    const email = uniqueEmail('la');
    const sub = `g-${randomUUID()}`;
    const res = await google(await googleToken({ email, sub }));
    expect(res.status).toBe(401);
    expect(res.body.type).toBe('/problems/google_account_not_found');
    const created = await db.query('select 1 from staff.accounts where email = $1 or google_sub = $2', [email, sub]);
    expect(created.rows).toHaveLength(0);
  });

  it('AC-A4: tài khoản đã gắn sub khác → 401 google_account_not_found, google_sub giữ nguyên', async () => {
    const { email } = await registerCompany();
    const first = `g-${randomUUID()}`;
    expect((await google(await googleToken({ email, sub: first }))).status).toBe(200);
    const res = await google(await googleToken({ email, sub: `g-${randomUUID()}` }));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('google_account_not_found');
    expect((await account(email)).google_sub).toBe(first);
  });

  it('AC-A5: token sai aud hoặc email chưa xác minh → 401 google_token_invalid', async () => {
    const { email } = await registerCompany();
    for (const claims of [{ aud: 'khac.apps.googleusercontent.com' }, { email_verified: false }]) {
      const res = await google(await googleToken({ email, sub: `g-${randomUUID()}`, ...claims }));
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('google_token_invalid');
    }
    expect((await account(email)).google_sub).toBeNull();
  });

  it('AC-A5: không lấy được khoá của Google → 503 google_unavailable', async () => {
    const credential = await googleToken({ email: uniqueEmail(), sub: 'g-x' });
    setGoogleKeySource(() => {
      throw new errors.JWKSTimeout();
    });
    try {
      const res = await google(credential);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('google_unavailable');
    } finally {
      restoreKeys();
    }
  });

  it('credential quá ngắn → 422 errors.credential', async () => {
    const res = await google('ngan');
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.errors)).toEqual(['credential']);
  });

  it('AC-A6: sau đăng nhập Google, công ty khoá → 403 company_locked; membership khoá → 403 account_locked; công ty khác vẫn vào được', async () => {
    const a = await createCompany();
    const b = await createCompany();
    const member = await addMember(a.companyId, 'sale');
    const memberB = await db.query<{ id: string }>(
      'insert into staff.memberships (company_id, account_id) values ($1, $2) returning id',
      [b.companyId, member.accountId],
    );
    await db.query('insert into access.member_roles (membership_id, role_id, company_id) values ($1, $2, $3)', [
      memberB.rows[0]!.id,
      BUILTIN_ROLES.sale.id,
      b.companyId,
    ]);
    await suspendMembership(member.membershipId);
    const res = await google(await googleToken({ email: member.email, sub: `g-${randomUUID()}` }));
    expect(res.status).toBe(200);
    const token = res.body.accessToken as string;
    expect((await selectCompany(token, a.companyId)).body.code).toBe('account_locked');
    expect((await selectCompany(token, b.companyId)).status).toBe(200);
    await lockCompany(b.companyId);
    expect((await selectCompany(token, b.companyId)).body.code).toBe('company_locked');
  });

  it('AC-A6: tài khoản còn phải đổi mật khẩu thì token Google cũng mang cờ đó', async () => {
    const { email, companyId } = await registerCompany();
    await db.query('update staff.accounts set must_change_password = true where email = $1', [email]);
    const res = await google(await googleToken({ email, sub: `g-${randomUUID()}` }));
    expect(res.status).toBe(200);
    expect(res.body.account.mustChangePassword).toBe(true);
    const select = await selectCompany(res.body.accessToken, companyId);
    expect(select.status).toBe(403);
    expect(select.body.code).toBe('password_change_required');
  });

  // Giao dịch giữ khoá đóng vai request kia đang liên kết dở: request đua đã đọc thấy `google_sub` trống, chỉ bị chặn
  // ở câu UPDATE có điều kiện, rồi đọc lại sau khi bên kia commit.
  const linkingInFlight = (email: string, sub: string) => (holder: PoolClient) =>
    holder.query('update staff.accounts set google_sub = $2 where email = $1', [email, sub]);

  it('chạy đua: hai lần liên kết cùng tài khoản với hai sub khác nhau → request sau 401, giữ liên kết trước', async () => {
    const { email } = await registerCompany();
    const first = `g-${randomUUID()}`;
    const res = await raceBehindLock(linkingInFlight(email, first), 1, async () =>
      google(await googleToken({ email, sub: `g-${randomUUID()}` })),
    );
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('google_account_not_found');
    expect((await account(email)).google_sub).toBe(first);
  });

  it('chạy đua: hai lần đăng nhập cùng sub lần đầu → request sau vẫn 200, không ghi nhật ký lần hai', async () => {
    const { email } = await registerCompany();
    const sub = `g-${randomUUID()}`;
    const credential = await googleToken({ email, sub });
    const res = await raceBehindLock(linkingInFlight(email, sub), 1, () => google(credential));
    expect(res.status).toBe(200);
    expect((await linkLogs((await account(email)).id)).rows).toHaveLength(0);
  });

  it('Promise.all hai lần liên kết cùng sub → cả hai 200, đúng một dòng nhật ký', async () => {
    const { email } = await registerCompany();
    const sub = `g-${randomUUID()}`;
    const credential = await googleToken({ email, sub });
    const [x, y] = await Promise.all([google(credential), google(credential)]);
    expect([x.status, y.status]).toEqual([200, 200]);
    expect((await linkLogs((await account(email)).id)).rows).toHaveLength(1);
  });
});
