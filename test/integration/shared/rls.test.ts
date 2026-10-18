import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { BUILTIN_ROLES } from '#src/modules/access/domain/catalog.ts';
import { testPool } from '../helpers/db.ts';
import { asCompany } from '../helpers/rls.ts';

const pool = testPool();

const companyA = randomUUID();
const companyB = randomUUID();

beforeAll(async () => {
  // Role đăng nhập là chủ bảng nên bỏ qua RLS: dùng để dựng dữ liệu hai công ty.
  for (const company of [companyA, companyB]) {
    const account = await pool.query<{ id: string }>(
      'insert into staff.accounts (email, full_name) values ($1, $2) returning id',
      [`${company}@test.vn`, 'Người thử'],
    );
    const membership = await pool.query<{ id: string }>(
      'insert into staff.memberships (company_id, account_id) values ($1, $2) returning id',
      [company, account.rows[0]!.id],
    );
    await pool.query('insert into access.member_roles (membership_id, role_id, company_id) values ($1, $2, $3)', [
      membership.rows[0]!.id,
      BUILTIN_ROLES.sale.id,
      company,
    ]);
    await pool.query("insert into access.roles (company_id, name, kind) values ($1, 'Kế toán', 'custom')", [company]);
    await pool.query("insert into audit.audit_logs (company_id, action, entity_type) values ($1, 'create', 'test')", [company]);
  }
  await pool.query("insert into audit.audit_logs (company_id, action, entity_type) values (null, 'create', 'platform.companies')");
});

describe('Row-Level Security theo công ty (AC-16)', () => {
  it('trong công ty A chỉ thấy membership, vai trò gán, nhật ký của A', async () => {
    await asCompany(companyA, async (c) => {
      const m = await c.query('select company_id from staff.memberships');
      expect(m.rows.map((r) => r.company_id)).toEqual([companyA]);
      const mr = await c.query('select company_id from access.member_roles');
      expect(mr.rows.map((r) => r.company_id)).toEqual([companyA]);
      const logs = await c.query('select company_id from audit.audit_logs');
      expect(logs.rows.map((r) => r.company_id)).toEqual([companyA]);
    });
  });

  it('vai trò có sẵn ai cũng thấy, vai trò tuỳ biến chỉ công ty mình thấy', async () => {
    await asCompany(companyA, async (c) => {
      const r = await c.query<{ company_id: string | null; name: string }>('select company_id, name from access.roles');
      expect(r.rows.filter((x) => x.company_id === null)).toHaveLength(4);
      expect(r.rows.filter((x) => x.company_id !== null).map((x) => x.company_id)).toEqual([companyA]);
    });
  });

  it('không ghi được dòng mang mã công ty khác', async () => {
    await expect(
      asCompany(companyA, (c) =>
        c.query("insert into access.roles (company_id, name, kind) values ($1, 'Lén', 'custom')", [companyB]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('không sửa được vai trò có sẵn trong công ty', async () => {
    await expect(
      asCompany(companyA, (c) => c.query("update access.roles set name = 'Đổi' where id = $1", [BUILTIN_ROLES.ceo.id])),
    ).rejects.toThrow(/row-level security/);
  });

  it('chưa đặt app.company_id thì không thấy dòng nào', async () => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role commerio_app');
      const m = await client.query('select 1 from staff.memberships');
      expect(m.rowCount).toBe(0);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });

  it('role ứng dụng không đọc được refresh token, không sửa được nhật ký', async () => {
    await expect(asCompany(companyA, (c) => c.query('select 1 from identity.refresh_tokens'))).rejects.toThrow(
      /permission denied/,
    );
    await expect(asCompany(companyA, (c) => c.query('delete from audit.audit_logs'))).rejects.toThrow(/permission denied/);
  });
});
