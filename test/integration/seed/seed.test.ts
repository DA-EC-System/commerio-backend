import { describe, expect, it } from 'vitest';
import { BUILTIN_ROLES } from '#src/modules/core/access/domain/catalog.ts';
import { seedDemo, type SeedDemoInput } from '../../../db/seed/demo.ts';
import { registerCompany, uniqueEmail } from '../helpers/company.ts';
import { testPool } from '../helpers/db.ts';
import { login, PASSWORD, selectCompany } from '../helpers/http.ts';

const db = testPool();

// Email riêng mỗi ca: DB test dùng chung giữa các file (test/CLAUDE.md), không dùng email @commerio.dev cố định.
function demoInput(): SeedDemoInput {
  return {
    company: { name: 'Công ty Demo Thử', taxCode: '0300000037' },
    password: PASSWORD,
    accounts: {
      ceo: { email: uniqueEmail('ceo'), fullName: 'CEO Demo' },
      admin: { email: uniqueEmail('admin'), fullName: 'Admin Demo' },
      sale: { email: uniqueEmail('sale'), fullName: 'Sale Demo' },
      kho: { email: uniqueEmail('kho'), fullName: 'Kho Demo' },
    },
  };
}

/** Số dòng của đúng công ty demo và bốn email seed. */
async function counts(input: SeedDemoInput) {
  const emails = Object.values(input.accounts).map((a) => a.email);
  const { rows } = await db.query<{ companies: string; accounts: string; memberships: string; member_roles: string }>(
    `select
       (select count(distinct m.company_id) from staff.memberships m join staff.accounts a on a.id = m.account_id
          where a.email = any($1)) companies,
       (select count(*) from staff.accounts where email = any($1)) accounts,
       (select count(*) from staff.memberships m join staff.accounts a on a.id = m.account_id where a.email = any($1)) memberships,
       (select count(*) from access.member_roles r join staff.memberships m on m.id = r.membership_id
          join staff.accounts a on a.id = m.account_id where a.email = any($1)) member_roles`,
    [emails],
  );
  return rows[0];
}

async function roleOf(email: string, companyId: string): Promise<string[]> {
  const { rows } = await db.query<{ role_id: string }>(
    `select r.role_id from access.member_roles r join staff.memberships m on m.id = r.membership_id
       join staff.accounts a on a.id = m.account_id where a.email = $1 and m.company_id = $2`,
    [email, companyId],
  );
  return rows.map((r) => r.role_id);
}

describe('seed dữ liệu demo P1 (#37 AC-4)', () => {
  it('tạo một công ty, bốn tài khoản đúng vai trò có sẵn, đăng nhập và chọn công ty được', async () => {
    const input = demoInput();
    const { companyId } = await seedDemo(input);

    expect(await counts(input)).toEqual({ companies: '1', accounts: '4', memberships: '4', member_roles: '4' });
    for (const role of ['ceo', 'admin', 'sale', 'kho'] as const) {
      expect(await roleOf(input.accounts[role].email, companyId)).toEqual([BUILTIN_ROLES[role].id]);
    }

    const { token, body } = await login(input.accounts.sale.email);
    expect(body.memberships.map((m: { companyId: string }) => m.companyId)).toEqual([companyId]);
    const perms = async (email: string) => {
      const companyToken = await selectCompany((await login(email)).token, companyId);
      return JSON.parse(Buffer.from(companyToken.split('.')[1]!, 'base64url').toString()).perms as string[];
    };
    expect(await perms(input.accounts.sale.email)).not.toContain('identity.role.manage');
    expect(await perms(input.accounts.sale.email)).not.toContain('identity.role.view');
    expect(await perms(input.accounts.ceo.email)).toContain('identity.role.manage');
    await selectCompany(token, companyId);
  });

  it('chạy lại không sinh bản ghi trùng', async () => {
    const input = demoInput();
    const first = await seedDemo(input);
    const before = await counts(input);
    const second = await seedDemo(input);

    expect(second.companyId).toBe(first.companyId);
    expect(await counts(input)).toEqual(before);
  });

  it('lần trước chết giữa chừng (chưa tạo tới nhân viên sau) thì bù đủ', async () => {
    const input = demoInput();
    const { companyId } = await seedDemo(input);
    // Mỗi nhân viên một giao dịch: chết sau admin thì sale, kho chưa có gì.
    for (const email of [input.accounts.sale.email, input.accounts.kho.email]) {
      const where = 'in (select m.id from staff.memberships m join staff.accounts a on a.id = m.account_id where a.email = $1)';
      await db.query(`delete from access.member_roles where membership_id ${where}`, [email]);
      await db.query('delete from staff.memberships where account_id = (select id from staff.accounts where email = $1)', [email]);
      await db.query('delete from staff.accounts where email = $1', [email]);
    }

    await seedDemo(input);

    expect(await counts(input)).toEqual({ companies: '1', accounts: '4', memberships: '4', member_roles: '4' });
    expect(await roleOf(input.accounts.sale.email, companyId)).toEqual([BUILTIN_ROLES.sale.id]);
    expect(await roleOf(input.accounts.kho.email, companyId)).toEqual([BUILTIN_ROLES.kho.id]);
  });

  it('email CEO seed đã bị người khác đăng ký (mật khẩu khác) thì báo lỗi, không thêm nhân viên vào công ty đó', async () => {
    const input = demoInput();
    const { companyId } = await registerCompany(input.accounts.ceo.email);

    await expect(seedDemo({ ...input, password: 'MatKhauKhac99' })).rejects.toThrow(/ceo-/);
    const { rows } = await db.query('select count(*)::int n from staff.memberships where company_id = $1', [companyId]);
    expect(rows[0].n).toBe(1);
  });

  it('email nhân viên seed đã thuộc công ty khác thì báo lỗi', async () => {
    const input = demoInput();
    await registerCompany(input.accounts.admin.email);

    await expect(seedDemo(input)).rejects.toThrow(/admin-/);
  });
});
