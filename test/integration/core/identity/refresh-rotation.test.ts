import { createHash } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { registerCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { login, PASSWORD, refreshCookie, testApp } from '../../helpers/http.ts';
import { raceBehindLock } from '../../helpers/locks.ts';

// Xoay vòng refresh token có hạn dùng lại và phát hiện dùng lại (RFC 9700 §4.14.2): F5 hai lần, nhiều tab
// refresh cùng lúc không bị đăng xuất; token cũ dùng lại sau hạn thì thu hồi cả họ token.
const db = testPool();
const refresh = (cookie: string) => request(testApp()).post('/api/v1/identity/refresh').set('Cookie', cookie);
const hashOf = (cookie: string) => createHash('sha256').update(cookie.split('=')[1]!).digest('hex');
const clearsCookie = (res: request.Response) => String(res.headers['set-cookie'] ?? '').includes('commerio_refresh=;');

/** Lùi mốc xoay vòng của token cho quá hạn dùng lại (không chờ giờ thật). */
const ageRotation = (cookie: string) =>
  db.query(`update core.refresh_tokens set rotated_at = now() - interval '1 hour' where token_hash = $1`, [hashOf(cookie)]);

describe('refresh xoay vòng có hạn dùng lại', () => {
  it('hai refresh cùng lúc bằng một cookie đều 200, không xoá cookie, hai cookie mới đều dùng được', async () => {
    const { email } = await registerCompany();
    const { cookie } = await login(email);
    const [a, b] = await raceBehindLock(
      (holder) => holder.query('select 1 from core.refresh_tokens where token_hash = $1 for update', [hashOf(cookie)]),
      2,
      () => Promise.all([refresh(cookie), refresh(cookie)]),
    );
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(clearsCookie(a) || clearsCookie(b)).toBe(false);
    const [ca, cb] = [refreshCookie(a), refreshCookie(b)];
    expect(ca).not.toBe(cb);
    expect((await refresh(ca)).status).toBe(200);
    expect((await refresh(cb)).status).toBe(200);
  });

  it('dùng lại token cũ trong hạn thì 200 với cặp token mới cùng họ; token kế tiếp vẫn dùng được', async () => {
    const { email } = await registerCompany();
    const { cookie } = await login(email);
    const first = await refresh(cookie);
    expect(first.status).toBe(200);
    const again = await refresh(cookie);
    expect(again.status).toBe(200);
    expect(refreshCookie(again)).not.toBe(refreshCookie(first));

    const families = await db.query<{ family_id: string }>(
      'select distinct family_id from core.refresh_tokens where token_hash = any($1)',
      [[cookie, refreshCookie(first), refreshCookie(again)].map(hashOf)],
    );
    expect(families.rows).toHaveLength(1);
    expect((await refresh(refreshCookie(first))).status).toBe(200);
    expect((await refresh(refreshCookie(again))).status).toBe(200);
  });

  it('dùng lại token cũ quá hạn thì 401, thu hồi cả họ token, ghi nhật ký; phiên đăng nhập khác không ảnh hưởng', async () => {
    const { email } = await registerCompany();
    const { cookie } = await login(email);
    const other = await login(email);
    const next = refreshCookie(await refresh(cookie));
    await ageRotation(cookie);

    const reused = await refresh(cookie);
    expect(reused.status).toBe(401);
    expect(reused.body.code).toBe('unauthorized');
    expect((await refresh(next)).status).toBe(401);
    expect((await refresh(other.cookie)).status).toBe(200);

    const log = await db.query(
      `select l.action, l.after->>'reason' as reason from core.audit_logs l join core.accounts a on a.id = l.actor_id
       where a.email = $1 and l.entity_type = 'core.refresh_tokens'`,
      [email],
    );
    expect(log.rows).toEqual([{ action: 'update', reason: 'refresh_token_reuse' }]);
  });

  it('đăng xuất rồi thì token cũ trong hạn dùng lại cũng 401', async () => {
    const { email } = await registerCompany();
    const { cookie } = await login(email);
    const next = refreshCookie(await refresh(cookie));
    expect((await request(testApp()).post('/api/v1/identity/logout').set('Cookie', next)).status).toBe(204);
    expect((await refresh(cookie)).status).toBe(401);
    expect((await refresh(next)).status).toBe(401);
  });

  it('đăng xuất bằng cookie cũ trong hạn thu hồi cả token kế tiếp', async () => {
    const { email } = await registerCompany();
    const { cookie } = await login(email);
    const next = refreshCookie(await refresh(cookie));
    expect((await request(testApp()).post('/api/v1/identity/logout').set('Cookie', cookie)).status).toBe(204);
    expect((await refresh(next)).status).toBe(401);
  });

  it('đổi mật khẩu thu hồi cả token cũ còn trong hạn dùng lại', async () => {
    const { email } = await registerCompany();
    const { token, cookie } = await login(email);
    const next = refreshCookie(await refresh(cookie));
    const res = await request(testApp())
      .post('/api/v1/identity/change-password')
      .set('Authorization', `Bearer ${token}`)
      .set('Cookie', next)
      .send({ currentPassword: PASSWORD, newPassword: 'MatKhauMoi9' });
    expect(res.status).toBe(204);
    expect((await refresh(cookie)).status).toBe(401);
    expect((await refresh(next)).status).toBe(401);
    expect((await refresh(refreshCookie(res))).status).toBe(200);
  });
});
