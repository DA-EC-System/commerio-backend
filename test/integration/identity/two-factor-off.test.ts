import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { enableTotp, saveTotpSecret } from '#src/modules/staff/repository/accounts.ts';
import { verifyAccessToken } from '#src/shared/auth/jwt.ts';
import { registerCompany } from '../helpers/company.ts';
import { testPool } from '../helpers/db.ts';
import { PASSWORD, testApp } from '../helpers/http.ts';

const app = testApp();
const db = testPool();

// TWO_FACTOR_MODE mặc định off (#7 [D], AC-D11): luồng đăng nhập như chưa có 2FA, kể cả tài khoản đã có cột TOTP.
describe('2FA tắt', () => {
  it('AC-D11: tài khoản đã bật 2FA vẫn đăng nhập thẳng; token không có cờ tfs, chọn công ty được', async () => {
    const { email, companyId } = await registerCompany();
    const account = await db.query<{ id: string }>('select id from staff.accounts where email = $1', [email]);
    const id = account.rows[0]!.id;
    expect(await saveTotpSecret(id, Buffer.from('ban-ma-gia'))).toBe(true);
    expect(await enableTotp(id, 1, [])).toBe(true);

    const login = await request(app).post('/api/v1/identity/login').send({ email, password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.mfaRequired).toBeUndefined();
    expect((await verifyAccessToken(login.body.accessToken)).twoFactorSetupRequired).toBe(false);
    const select = await request(app)
      .post('/api/v1/identity/select-company')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .send({ companyId });
    expect(select.status).toBe(200);
  });

  it('tài khoản chưa bật 2FA không mang cờ tfs', async () => {
    const { email } = await registerCompany();
    const login = await request(app).post('/api/v1/identity/login').send({ email, password: PASSWORD });
    expect((await verifyAccessToken(login.body.accessToken)).twoFactorSetupRequired).toBe(false);
  });
});
