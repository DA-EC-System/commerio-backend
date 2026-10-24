import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { registerBody, uniqueEmail } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';

const app = testApp();
const db = testPool();

// #51: hai lần đăng ký cùng email chạy song song. Cả hai qua được bước kiểm email trước khi ghi,
// bên ghi sau đụng UNIQUE của staff.accounts; Drizzle bọc lỗi nên mã 23505 nằm ở `cause`.
describe('đăng ký trùng email đồng thời (#51)', () => {
  it('một bên 201, bên kia 409 email_taken theo ô ceo.email; chỉ một tài khoản và một công ty', async () => {
    // Lặp vài lượt để chắc có lượt cả hai cùng qua bước kiểm trước khi ghi.
    for (let round = 0; round < 5; round++) {
      const email = uniqueEmail('dua');
      const names = [`Công ty đua A ${email}`, `Công ty đua B ${email}`];
      const results = await Promise.all(
        names.map((name) =>
          request(app)
            .post('/api/v1/identity/register')
            .send(registerBody(email, { company: { name, taxCode: '0312345678' } })),
        ),
      );

      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const loser = results.find((r) => r.status === 409)!;
      expect(loser.body.code).toBe('email_taken');
      expect(loser.body.errors).toHaveProperty(['ceo.email']);
      const accounts = await db.query('select count(*)::int as n from staff.accounts where email = $1', [email]);
      expect(accounts.rows[0].n).toBe(1);
      const companies = await db.query('select count(*)::int as n from platform.companies where name = any($1)', [names]);
      expect(companies.rows[0].n).toBe(1);
    }
  });
});
