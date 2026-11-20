import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { KNOWN_REGISTRATION_CODE, startRegistration, uniqueEmail, uniqueTaxCode } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';

const app = testApp();
const db = testPool();

// #51, #459: hai lần đăng ký cùng email nhập mã đúng cùng lúc. Cả hai qua bước kiểm email trước khi ghi, bên ghi sau
// đụng UNIQUE của core.accounts; Drizzle bọc lỗi nên mã 23505 nằm ở `cause`.
describe('đăng ký trùng email đồng thời (#51)', () => {
  it('một bên 201, bên kia 409 email_taken theo ô ceo.email; chỉ một tài khoản và một công ty', async () => {
    for (let round = 0; round < 5; round++) {
      const email = uniqueEmail('dua');
      const names = [`Công ty đua A ${email}`, `Công ty đua B ${email}`];
      const ids = await Promise.all(names.map((name) => startRegistration(email, { company: { name, taxCode: uniqueTaxCode() } })));
      const results = await Promise.all(
        ids.map((registrationId) =>
          request(app).post('/api/v1/identity/register/verify').send({ registrationId, code: KNOWN_REGISTRATION_CODE }),
        ),
      );

      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const loser = results.find((r) => r.status === 409)!;
      expect(loser.body.code).toBe('email_taken');
      expect(loser.body.errors).toHaveProperty(['ceo.email']);
      const accounts = await db.query('select count(*)::int as n from core.accounts where email = $1', [email]);
      expect(accounts.rows[0].n).toBe(1);
      const companies = await db.query('select count(*)::int as n from core.companies where name = any($1)', [names]);
      expect(companies.rows[0].n).toBe(1);
    }
  });
});
