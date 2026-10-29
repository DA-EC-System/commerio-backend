import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '#src/modules/core/identity/service/passwords.ts';
import { addMember, registerCompany, uniqueEmail } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { login, PASSWORD, selectCompany, testApp } from '../../helpers/http.ts';
import { raceBehindLock } from '../../helpers/locks.ts';

// Quản trị nền tảng: xem, khoá, mở khoá công ty và nhật ký cấp nền tảng (UC-PI-08, Documents/21 V18, #152).

const as = (token: string | null) => {
  const auth = (r: request.Test) => (token ? r.set('Authorization', `Bearer ${token}`) : r);
  return {
    get: (path: string) => auth(request(testApp()).get(`/api/v1${path}`)),
    post: (path: string, body: object) => auth(request(testApp()).post(`/api/v1${path}`)).send(body),
  };
};

/** Tài khoản quản trị nền tảng (cờ trong `core.accounts`, không thuộc công ty nào), đã đăng nhập. */
async function platformAdmin() {
  const email = uniqueEmail('qtnt');
  const { rows } = await testPool().query<{ id: string }>(
    `insert into core.accounts (email, full_name, password_hash, is_platform_admin)
     values ($1, 'Quản Trị Nền Tảng', $2, true) returning id`,
    [email, await hashPassword(PASSWORD)],
  );
  return { accountId: rows[0]!.id, email, token: (await login(email)).token };
}

/** Công ty có tên riêng để tìm, kèm CEO đã chọn công ty. */
async function namedCompany() {
  const name = `Công ty ${randomUUID().slice(0, 8)}`;
  const { email, companyId } = await registerCompany(uniqueEmail(), {
    company: { name, taxCode: '0399999999' },
    optionalModules: ['channel'],
  });
  return { name, companyId, ceoEmail: email, ceoToken: await selectCompany((await login(email)).token, companyId) };
}

let admin: Awaited<ReturnType<typeof platformAdmin>>;
beforeAll(async () => {
  admin = await platformAdmin();
});

describe('chỉ quản trị nền tảng', () => {
  it('không có cờ: 403 forbidden; không token: 401', async () => {
    const c = await namedCompany();
    expect((await as(c.ceoToken).get('/platform/companies')).body.type).toBe('/problems/forbidden');
    expect((await as(c.ceoToken).get('/platform/overview')).status).toBe(403);
    expect((await as(null).get('/platform/audit-logs')).status).toBe(401);
  });

  it('gỡ cờ thì request kế tiếp bị chặn, không chờ token hết hạn', async () => {
    const other = await platformAdmin();
    expect((await as(other.token).get('/platform/overview')).status).toBe(200);
    await testPool().query('update core.accounts set is_platform_admin = false where id = $1', [other.accountId]);
    expect((await as(other.token).get('/platform/overview')).status).toBe(403);
  });

  it('token phát trước lần đổi mật khẩu gần nhất nhận 401, như authorize (#62)', async () => {
    const other = await platformAdmin();
    const changed = await as(other.token).post('/identity/change-password', {
      currentPassword: PASSWORD,
      newPassword: 'MatKhauMoi456',
    });
    expect(changed.status).toBe(204);
    expect((await as(other.token).get('/platform/overview')).body.type).toBe('/problems/unauthorized');
  });

  it('không đọc được dữ liệu kinh doanh của công ty: token không có công ty', async () => {
    expect((await as(admin.token).get('/purchasing/suppliers')).body.type).toBe('/problems/company_not_selected');
  });
});

describe('GET /platform/companies', () => {
  it('trả công ty kèm CEO, phân hệ tuỳ chọn đang bật; tìm theo tên, MST, email CEO; lọc trạng thái', async () => {
    const c = await namedCompany();
    const res = await as(admin.token).get(`/platform/companies?search=${encodeURIComponent(c.name)}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toEqual({
      id: c.companyId,
      name: c.name,
      taxCode: '0399999999',
      ceoName: 'Nguyễn Văn Thử',
      ceoEmail: c.ceoEmail,
      optionalModules: ['channel'],
      status: 'active',
      lockReason: null,
      lockedAt: null,
      createdAt: expect.any(String),
      version: 1,
    });
    expect((await as(admin.token).get(`/platform/companies?search=${c.ceoEmail.toUpperCase()}`)).body.total).toBe(1);
    expect((await as(admin.token).get('/platform/companies?search=0399999999&pageSize=1')).body.items).toHaveLength(1);
    const locked = await as(admin.token).get(`/platform/companies?search=${encodeURIComponent(c.name)}&status=locked`);
    expect(locked.body.total).toBe(0);
    expect((await as(admin.token).get('/platform/companies?search=%25_')).status).toBe(200);
  });
});

describe('khoá, mở khoá công ty', () => {
  it('khoá: thành viên bị chặn ngay; khoá lại cùng version 409; mở khoá: dùng lại được', async () => {
    const c = await namedCompany();
    const member = await addMember(c.companyId, 'sale');
    const locked = await as(admin.token).post(`/platform/companies/${c.companyId}/lock`, { reason: ' Vi phạm điều khoản ', version: 1 });
    expect(locked.status).toBe(200);
    expect(locked.body).toMatchObject({ status: 'locked', lockReason: 'Vi phạm điều khoản', lockedAt: expect.any(String), version: 2 });
    expect((await as(member.token).get('/audit/logs')).body.type).toBe('/problems/company_locked');
    expect((await as(c.ceoToken).get('/platform/modules')).body.type).toBe('/problems/company_locked');

    const again = await as(admin.token).post(`/platform/companies/${c.companyId}/lock`, { reason: 'Lần hai', version: 2 });
    expect(again.status).toBe(409);
    expect(again.body.type).toBe('/problems/version_conflict');
    expect(again.body.current).toMatchObject({ id: c.companyId, status: 'locked', version: 2 });

    const unlocked = await as(admin.token).post(`/platform/companies/${c.companyId}/unlock`, { version: 2 });
    expect(unlocked.status).toBe(200);
    expect(unlocked.body).toMatchObject({ status: 'active', lockReason: null, lockedAt: null, version: 3 });
    expect((await as(c.ceoToken).get('/platform/modules')).status).toBe(200);
    expect((await as(admin.token).post(`/platform/companies/${c.companyId}/unlock`, { version: 3 })).status).toBe(409);
  });

  it('thiếu lý do 422 errors.reason; version cũ 409; công ty không có hay id sai dạng 404', async () => {
    const c = await namedCompany();
    const blank = await as(admin.token).post(`/platform/companies/${c.companyId}/lock`, { reason: '   ', version: 1 });
    expect(blank.status).toBe(422);
    expect(blank.body.errors).toHaveProperty('reason');
    expect((await as(admin.token).post(`/platform/companies/${c.companyId}/lock`, { reason: 'x', version: 9 })).status).toBe(409);
    expect((await as(admin.token).post(`/platform/companies/${randomUUID()}/lock`, { reason: 'x', version: 1 })).status).toBe(404);
    expect((await as(admin.token).post('/platform/companies/abc/lock', { reason: 'x', version: 1 })).status).toBe(404);
  });

  it('hai lần khoá cùng version chạy song song: một 200, một 409', async () => {
    const c = await namedCompany();
    const results = await raceBehindLock(
      (holder) => holder.query('select 1 from core.companies where id = $1 for update', [c.companyId]),
      2,
      () =>
        Promise.all([
          as(admin.token).post(`/platform/companies/${c.companyId}/lock`, { reason: 'A', version: 1 }),
          as(admin.token).post(`/platform/companies/${c.companyId}/lock`, { reason: 'B', version: 1 }),
        ]),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });
});

describe('nhật ký cấp nền tảng và tổng quan', () => {
  it('có đăng ký, khoá (kèm lý do), mở khoá; lọc theo action, tìm theo tên công ty', async () => {
    const c = await namedCompany();
    await as(admin.token).post(`/platform/companies/${c.companyId}/lock`, { reason: 'Nợ phí', version: 1 });
    await as(admin.token).post(`/platform/companies/${c.companyId}/unlock`, { version: 2 });

    const res = await as(admin.token).get(`/platform/audit-logs?search=${encodeURIComponent(c.name)}`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((l: { action: string }) => l.action)).toEqual([
      'company.unlocked',
      'company.locked',
      'company.registered',
    ]);
    expect(res.body.items[1]).toMatchObject({
      targetCompanyId: c.companyId,
      targetCompanyName: c.name,
      actorEmail: admin.email,
      reason: 'Nợ phí',
    });
    expect(res.body.items[2].actorEmail).toBe(c.ceoEmail);
    const onlyLocked = await as(admin.token).get(`/platform/audit-logs?action=company.locked&search=${encodeURIComponent(c.name)}`);
    expect(onlyLocked.body.total).toBe(1);
    expect((await as(admin.token).get(`/platform/audit-logs?search=${admin.email}`)).body.total).toBeGreaterThanOrEqual(2);
  });

  it('tổng quan đếm công ty theo trạng thái, phân hệ tuỳ chọn, năm hoạt động gần nhất', async () => {
    await namedCompany();
    const res = await as(admin.token).get('/platform/overview');
    expect(res.status).toBe(200);
    expect(res.body.totalCompanies).toBe(res.body.activeCompanies + res.body.lockedCompanies);
    expect(res.body.registeredLast30Days).toBeGreaterThanOrEqual(1);
    expect(res.body.optionalModuleUsage.map((u: { module: string }) => u.module)).toEqual([
      'purchasing',
      'channel',
      'inbox',
      'assistant',
      'report',
    ]);
    expect(res.body.recentActivities.length).toBeLessThanOrEqual(5);
    expect(res.body.recentActivities[0]).toHaveProperty('action');
  });
});
