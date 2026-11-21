import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_ROLES } from '#src/modules/core/access/domain/catalog.ts';
import { hashPassword } from '#src/modules/core/identity/service/passwords.ts';
import { runTestCompanyCleanup } from '#src/modules/core/platform/service/test-company.ts';
import { env } from '#src/shared/config/env.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, registerCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { login, PASSWORD, selectCompany, testApp } from '../../helpers/http.ts';
import { suspendMembership } from '../../helpers/state.ts';
import { seedPackage } from '../../order/fulfillment/helpers.ts';
import { receive } from '../../product/inventory/helpers.ts';

// Documents/21 mục 2.2: CEO xoá công ty thử của e2e. Route không được xoá công ty thật trong bất kỳ trường hợp nào: mỗi
// điều kiện chặn một ca, và ca chặn kiểm công ty vẫn còn nguyên.

const db = testPool();
const TEST_DOMAIN = 'dang-ky.test'; // vitest.config.ts
const testEmail = (prefix = 'ceo') => `${prefix}-${randomUUID()}@${TEST_DOMAIN}`;
const del = (token?: string) => {
  const req = request(testApp()).delete('/api/v1/platform/company');
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
};

/** Công ty thử đăng ký qua API bằng email miền thử; token của CEO đã gắn công ty. */
async function testCompany() {
  const { email, companyId, accessToken } = await registerCompany(testEmail());
  return { email, companyId, token: accessToken };
}

/** Thành viên email miền thử, vai trò có sẵn, đăng nhập và chọn công ty. */
async function addTestMember(companyId: string, roleId: string, email = testEmail('nv')) {
  const existing = await db.query<{ id: string }>('select id from core.accounts where email = $1', [email]);
  const accountId =
    existing.rows[0]?.id
    ?? (
      await db.query<{ id: string }>(
        'insert into core.accounts (email, full_name, password_hash) values ($1, $2, $3) returning id',
        [email, 'Nhân Viên Thử', await hashPassword(PASSWORD)],
      )
    ).rows[0]!.id;
  const m = await db.query<{ id: string }>(
    'insert into core.memberships (company_id, account_id) values ($1, $2) returning id',
    [companyId, accountId],
  );
  await db.query('insert into core.member_roles (membership_id, role_id, company_id) values ($1, $2, $3)', [
    m.rows[0]!.id,
    roleId,
    companyId,
  ]);
  const { token } = await login(email);
  return { accountId, membershipId: m.rows[0]!.id, email, token: await selectCompany(token, companyId) };
}

const companyExists = async (id: string) =>
  (await db.query('select 1 from core.companies where id = $1', [id])).rowCount === 1;
const accountExists = async (email: string) =>
  (await db.query('select 1 from core.accounts where email = $1', [email])).rowCount === 1;

async function expectBlocked(token: string, companyId: string, status: number, code: string) {
  const res = await del(token);
  expect(res.status).toBe(status);
  expect(res.body.type).toContain(code);
  expect(await companyExists(companyId)).toBe(true);
  expect((await db.query('select count(*)::int as n from core.memberships where company_id = $1', [companyId])).rows[0].n)
    .toBeGreaterThan(0);
}

describe('DELETE /platform/company: điều kiện chặn', () => {
  const savedDomain = env.REGISTRATION_TEST_EMAIL_DOMAIN;
  afterEach(() => {
    (env as { REGISTRATION_TEST_EMAIL_DOMAIN?: string }).REGISTRATION_TEST_EMAIL_DOMAIN = savedDomain;
  });

  it('404 khi server không bật đăng ký thử (production), công ty còn nguyên', async () => {
    const c = await testCompany();
    (env as { REGISTRATION_TEST_EMAIL_DOMAIN?: string }).REGISTRATION_TEST_EMAIL_DOMAIN = undefined;
    await expectBlocked(c.token, c.companyId, 404, 'not_found');
  });

  it('401 khi thiếu token', async () => {
    expect((await del()).status).toBe(401);
  });

  it('403 forbidden khi token chưa chọn công ty', async () => {
    const c = await testCompany();
    const { token } = await login(c.email);
    const res = await del(token);
    expect(res.status).toBe(403);
    expect(res.body.type).toContain('forbidden');
    expect(await companyExists(c.companyId)).toBe(true);
  });

  it('403 forbidden khi người gọi không phải CEO, kể cả thành viên miền thử có quyền quản lý công ty', async () => {
    const c = await testCompany();
    const admin = await addTestMember(c.companyId, BUILTIN_ROLES.admin.id);
    await expectBlocked(admin.token, c.companyId, 403, 'forbidden');
  });

  it('403 forbidden khi CEO đã bị khoá trong công ty', async () => {
    const c = await testCompany();
    const ceo2 = await addTestMember(c.companyId, BUILTIN_ROLES.ceo.id);
    await suspendMembership(ceo2.membershipId);
    await expectBlocked(ceo2.token, c.companyId, 403, 'forbidden');
  });

  it('403 not_test_company khi có thành viên email ngoài miền thử', async () => {
    const c = await testCompany();
    const outsider = await addMember(c.companyId, 'sale');
    await expectBlocked(c.token, c.companyId, 403, 'not_test_company');
    expect(await accountExists(outsider.email)).toBe(true);
  });

  it('403 not_test_company khi thành viên ngoài miền thử đã bị khoá', async () => {
    const c = await testCompany();
    const outsider = await addMember(c.companyId, 'sale');
    await suspendMembership(outsider.membershipId);
    await expectBlocked(c.token, c.companyId, 403, 'not_test_company');
  });

  it('403 not_test_company khi có lời mời đang chờ gửi email ngoài miền thử', async () => {
    const c = await testCompany();
    const ceoId = (await db.query<{ id: string }>('select id from core.accounts where email = $1', [c.email])).rows[0]!.id;
    await db.query(
      `insert into core.invitations (company_id, role_ids, created_by, expires_at, status, email, full_name)
       values ($1, $2, $3, now() + interval '1 day', 'claimed', $4, 'Người Thật')`,
      [c.companyId, [BUILTIN_ROLES.sale.id], ceoId, `that-${randomUUID()}@gmail.com`],
    );
    await expectBlocked(c.token, c.companyId, 403, 'not_test_company');
  });

  it('403 not_test_company khi một thành viên là quản trị nền tảng, dù email thuộc miền thử', async () => {
    const c = await testCompany();
    const admin = await addTestMember(c.companyId, BUILTIN_ROLES.sale.id);
    await db.query('update core.accounts set is_platform_admin = true where id = $1', [admin.accountId]);
    await expectBlocked(c.token, c.companyId, 403, 'not_test_company');
    expect(await accountExists(admin.email)).toBe(true);
  });

  it('miền thử so nguyên phần sau @: email "x@evil-dang-ky.test" không lọt', async () => {
    const c = await testCompany();
    await addTestMember(c.companyId, BUILTIN_ROLES.sale.id, `x-${randomUUID()}@evil-${TEST_DOMAIN}`);
    await expectBlocked(c.token, c.companyId, 403, 'not_test_company');
  });
});

describe('DELETE /platform/company: xoá', () => {
  it('204: xoá công ty và mọi dữ liệu có company_id trong một giao dịch; tài khoản miền thử mồ côi bị xoá', async () => {
    const c = await testCompany();
    // Đủ chuỗi khoá ngoại: thẻ kho, đơn, dòng đơn, kiện, dòng kiện (trigger hoãn kiểm tổng dòng kiện lúc commit)
    const { variantId } = await createVariant(c.companyId);
    await receive(c.companyId, variantId, 10, 50000);
    await seedPackage(c.companyId, { status: 'reserved', lines: [{ variantId, quantity: 2, reserved: true }] });
    await seedPackage(c.companyId, { status: 'delivered', lines: [{ variantId, quantity: 1 }] });
    const sale = await addTestMember(c.companyId, BUILTIN_ROLES.sale.id);

    const res = await del(c.token);
    expect(res.status).toBe(204);
    expect(await companyExists(c.companyId)).toBe(false);
    for (const table of ['core.memberships', 'core.member_roles', 'core.company_modules', 'product.products', 'product.stock_moves',
      '"order".orders', '"order".order_lines', '"order".packages', '"order".package_lines', 'core.audit_logs', 'core.outbox_messages']) {
      const left = await db.query(`select 1 from ${table} where company_id = $1`, [c.companyId]);
      expect(left.rowCount, table).toBe(0);
    }
    const creationLog = await db.query(
      "select 1 from core.audit_logs where company_id is null and entity_type = 'core.companies' and entity_id = $1",
      [c.companyId],
    );
    expect(creationLog.rowCount).toBe(0);
    expect(await accountExists(c.email)).toBe(false);
    expect(await accountExists(sale.email)).toBe(false);
    // Token cũ không dùng được nữa
    expect((await del(c.token)).status).not.toBe(204);
  });

  it('tài khoản miền thử còn membership ở công ty khác thì giữ, chỉ xoá membership của công ty này', async () => {
    const a = await testCompany();
    const b = await testCompany();
    const shared = await addTestMember(a.companyId, BUILTIN_ROLES.sale.id);
    await addTestMember(b.companyId, BUILTIN_ROLES.sale.id, shared.email);

    expect((await del(a.token)).status).toBe(204);
    expect(await accountExists(shared.email)).toBe(true);
    const left = await db.query('select company_id from core.memberships where account_id = $1', [shared.accountId]);
    expect(left.rows.map((r) => r.company_id)).toEqual([b.companyId]);
    expect(await companyExists(b.companyId)).toBe(true);
  });
});

describe('việc nền platform.test_company_cleanup', () => {
  const backdate = (id: string, hours: number) =>
    db.query(`update core.companies set created_at = now() - make_interval(hours => $2) where id = $1`, [id, hours]);

  it('xoá công ty thử tạo quá 6 giờ, giữ công ty thử mới tạo và công ty có thành viên thật', async () => {
    const old = await testCompany();
    const fresh = await testCompany();
    const real = await testCompany();
    await addMember(real.companyId, 'sale');
    await backdate(old.companyId, 7);
    await backdate(real.companyId, 7);
    await backdate(fresh.companyId, 5);

    const deleted = await runTestCompanyCleanup();
    expect(deleted).toContain(old.companyId);
    expect(deleted).not.toContain(fresh.companyId);
    expect(deleted).not.toContain(real.companyId);
    expect(await companyExists(old.companyId)).toBe(false);
    expect(await companyExists(fresh.companyId)).toBe(true);
    expect(await companyExists(real.companyId)).toBe(true);
  });

  it('không xoá công ty có quản trị nền tảng', async () => {
    const c = await testCompany();
    const admin = await addTestMember(c.companyId, BUILTIN_ROLES.sale.id);
    await db.query('update core.accounts set is_platform_admin = true where id = $1', [admin.accountId]);
    await backdate(c.companyId, 7);
    expect(await runTestCompanyCleanup()).not.toContain(c.companyId);
    expect(await companyExists(c.companyId)).toBe(true);
  });

  it('server không bật đăng ký thử thì không xoá gì', async () => {
    const c = await testCompany();
    await backdate(c.companyId, 7);
    const saved = env.REGISTRATION_TEST_EMAIL_DOMAIN;
    (env as { REGISTRATION_TEST_EMAIL_DOMAIN?: string }).REGISTRATION_TEST_EMAIL_DOMAIN = undefined;
    try {
      expect(await runTestCompanyCleanup()).toEqual([]);
    } finally {
      (env as { REGISTRATION_TEST_EMAIL_DOMAIN?: string }).REGISTRATION_TEST_EMAIL_DOMAIN = saved;
    }
    expect(await companyExists(c.companyId)).toBe(true);
    await db.query('update core.companies set created_at = now() where id = $1', [c.companyId]);
  });
});
