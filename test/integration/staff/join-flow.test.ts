import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_ROLES } from '#src/modules/access/domain/catalog.ts';
import { setMailTransport } from '#src/shared/mail/index.ts';
import { createCompany, uniqueEmail } from '../helpers/company.ts';
import { testPool } from '../helpers/db.ts';
import { login, testApp } from '../helpers/http.ts';
import { captureMail, codeIn, deliverOtp, joinApi, newLink } from './helpers.ts';

const app = testApp();
const db = testPool();
const join = joinApi(app);

afterEach(() => setMailTransport(null));

// Luồng tham gia qua link (#7 [C], spec 5.3): open → claimed → pending → approved qua HTTP, thư qua transport giả.
describe('tham gia qua link', () => {
  it('email mới: mở link, xin mã, nhập mã, đặt mật khẩu, chờ duyệt; Admin duyệt; nhân viên đăng nhập bằng mật khẩu đã đặt', async () => {
    const sent = captureMail();
    const { companyId, ceo } = await createCompany();
    const company = await db.query<{ name: string }>('select name from platform.companies where id = $1', [companyId]);
    const link = await newLink(app, ceo.token, [BUILTIN_ROLES.sale.id]);
    const email = uniqueEmail('nhan-vien');

    const checked = await join.check(link.token);
    expect(checked.status).toBe(200);
    expect(checked.body).toEqual({ companyName: company.rows[0]!.name, expiresAt: expect.any(String) });

    const otp = await join.otp(link.token, email, 'Lê Văn Tâm');
    expect(otp.status).toBe(202);
    expect(otp.body).toEqual({});
    // Request không gửi thư: thư đi qua outbox tới worker.
    expect(sent).toEqual([]);
    await deliverOtp(link.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(email);

    const verified = await join.verify(link.token, email, codeIn(sent[0]!));
    expect(verified.status).toBe(200);
    expect(verified.body).toEqual({ registrationToken: expect.any(String), next: 'set_password' });

    const password = 'MatKhauMoi9';
    const completed = await join.complete({
      registrationToken: verified.body.registrationToken,
      password,
      confirmPassword: password,
    });
    expect(completed.status).toBe(200);
    expect(completed.body).toEqual({ status: 'pending' });
    // AC-C8: mật khẩu băm argon2id, chưa có tài khoản.
    const row = await db.query<{ status: string; password_hash: string; account_id: string | null }>(
      'select status, password_hash, account_id from staff.invitations where id = $1',
      [link.id],
    );
    expect(row.rows[0]).toMatchObject({ status: 'pending', account_id: null });
    expect(row.rows[0]!.password_hash).toMatch(/^\$argon2id\$/);
    expect((await db.query('select 1 from staff.accounts where email = $1', [email])).rowCount).toBe(0);

    const queue = await request(app).get('/api/v1/identity/invitations').set('Authorization', `Bearer ${ceo.token}`);
    const item = queue.body.items.find((i: { id: string }) => i.id === link.id);
    expect(item).toMatchObject({ email, fullName: 'Lê Văn Tâm', existingAccount: false, version: expect.any(Number) });

    const approved = await request(app)
      .post(`/api/v1/identity/invitations/${link.id}/approve`)
      .set('Authorization', `Bearer ${ceo.token}`)
      .send({ version: item.version });
    expect(approved.status).toBe(200);

    const { body } = await login(email, password);
    expect(body.memberships.map((m: { companyId: string }) => m.companyId)).toEqual([companyId]);
  });
});
