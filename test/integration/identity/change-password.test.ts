import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { registerCompany } from '../helpers/company.ts';
import { testPool } from '../helpers/db.ts';
import { login, PASSWORD, refreshCookie, testApp } from '../helpers/http.ts';

// Hai lỗ bảo mật của đổi mật khẩu (#4) vá trong #8 PR2 (plan P8, P9).
const changePassword = (token: string, body: object, cookie?: string) => {
  const req = request(testApp()).post('/api/v1/identity/change-password').set('Authorization', `Bearer ${token}`);
  if (cookie) req.set('Cookie', cookie);
  return req.send(body);
};
const refresh = (cookie: string) => request(testApp()).post('/api/v1/identity/refresh').set('Cookie', cookie);
const activeTokens = async (email: string) =>
  Number(
    (
      await testPool().query(
        `select count(*) from identity.refresh_tokens t join staff.accounts a on a.id = t.account_id
         where a.email = $1 and t.revoked_at is null and t.expires_at > now()`,
        [email],
      )
    ).rows[0].count,
  );

describe('đổi mật khẩu: giới hạn số lần sai theo tài khoản (AC-B1)', () => {
  it('5 lần lỗi trong 15 phút thì lần 6 bị 429, kể cả đúng mật khẩu; tài khoản khác không ảnh hưởng', async () => {
    const { email } = await registerCompany();
    const { token } = await login(email);
    // Body sai định dạng không tới handler nên không bị đếm.
    for (let i = 0; i < 3; i++) expect((await changePassword(token, { currentPassword: PASSWORD, newPassword: 'yeu' })).status).toBe(422);
    for (let i = 0; i < 5; i++) {
      const res = await changePassword(token, { currentPassword: `Sai${i}abc1`, newPassword: 'MatKhauMoi9' });
      expect(res.status).toBe(422);
    }
    const blocked = await changePassword(token, { currentPassword: PASSWORD, newPassword: 'MatKhauMoi9' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('too_many_requests');

    const other = await registerCompany();
    const { token: otherToken } = await login(other.email);
    expect((await changePassword(otherToken, { currentPassword: 'SaiSai123', newPassword: 'MatKhauMoi9' })).status).toBe(422);
  });

  it('đổi thành công không bị đếm', async () => {
    const { email } = await registerCompany();
    let password = PASSWORD;
    for (let i = 0; i < 6; i++) {
      const { token } = await login(email, password);
      const next = `MatKhauMoi${i}x`;
      expect((await changePassword(token, { currentPassword: password, newPassword: next })).status).toBe(204);
      password = next;
    }
  });
});

describe('đổi mật khẩu thu hồi mọi phiên khác (AC-B2)', () => {
  it('cookie của phiên khác và cookie cũ hết hiệu lực; cookie mới trong phản hồi dùng được', async () => {
    const { email } = await registerCompany();
    const first = await login(email);
    const second = await login(email);
    expect(await activeTokens(email)).toBe(2);

    const res = await changePassword(first.token, { currentPassword: PASSWORD, newPassword: 'MatKhauMoi9' }, first.cookie);
    expect(res.status).toBe(204);
    const fresh = refreshCookie(res);
    expect(fresh).not.toBe(first.cookie);
    expect(await activeTokens(email)).toBe(1);

    expect((await refresh(second.cookie)).status).toBe(401);
    expect((await refresh(first.cookie)).status).toBe(401);
    expect((await refresh(fresh)).status).toBe(200);
  });

  it('đổi thất bại (sai mật khẩu hiện tại) thì không thu hồi phiên nào', async () => {
    const { email } = await registerCompany();
    const first = await login(email);
    const second = await login(email);
    const res = await changePassword(first.token, { currentPassword: 'SaiSai123', newPassword: 'MatKhauMoi9' }, first.cookie);
    expect(res.status).toBe(422);
    expect(await activeTokens(email)).toBe(2);
    expect((await refresh(second.cookie)).status).toBe(200);
  });
});
