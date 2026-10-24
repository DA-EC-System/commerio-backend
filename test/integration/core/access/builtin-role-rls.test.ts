import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BUILTIN_ROLES } from '#src/modules/core/access/domain/catalog.ts';
import { createCustomRole } from '../../helpers/company.ts';
import { asCompany } from '../../helpers/rls.ts';

const SALE = BUILTIN_ROLES.sale.id;
const WAREHOUSE = BUILTIN_ROLES.kho.id;

// Vai trò có sẵn (company_id trống) dùng chung mọi công ty: request trong một công ty đọc được nhưng không sửa,
// không xoá được nó hay quyền của nó (backend#8 P11, đo R5/N1/N3 ở .claude/issues/backend-8/ground-truth.md).
describe('RLS vai trò có sẵn: công ty không ghi được (P11)', () => {
  it('vẫn đọc được vai trò có sẵn và quyền của chúng', async () => {
    const companyId = randomUUID();
    const res = await asCompany(companyId, (c) =>
      c.query('select count(*)::int as n from access.role_permissions where role_id = $1', [SALE]),
    );
    expect(res.rows[0].n).toBeGreaterThan(0);
  });

  it('không xoá được quyền của vai trò có sẵn', async () => {
    const companyId = randomUUID();
    const res = await asCompany(companyId, (c) => c.query('delete from access.role_permissions where role_id = $1', [SALE]));
    expect(res.rowCount).toBe(0);
  });

  it('không xoá được vai trò có sẵn', async () => {
    const companyId = randomUUID();
    const res = await asCompany(companyId, (c) => c.query('delete from access.roles where id = $1', [WAREHOUSE]));
    expect(res.rowCount).toBe(0);
  });

  it('không chuyển được quyền của vai trò có sẵn sang vai trò của công ty', async () => {
    const companyId = randomUUID();
    const own = await createCustomRole(companyId, []);
    const res = await asCompany(companyId, (c) =>
      c.query('update access.role_permissions set role_id = $1 where role_id = $2', [own, SALE]),
    );
    expect(res.rowCount).toBe(0);
  });

  it('không nhận được vai trò có sẵn về công ty mình', async () => {
    const companyId = randomUUID();
    const res = await asCompany(companyId, (c) =>
      c.query('update access.roles set company_id = $1 where id = $2', [companyId, SALE]),
    );
    expect(res.rowCount).toBe(0);
  });

  it('xoá thẳng vai trò tuỳ biến còn quyền: quyền đi theo (cascade) dưới policy mới', async () => {
    const companyId = randomUUID();
    const own = await createCustomRole(companyId, ['sales.order.view', 'sales.order.create']);
    const deleted = await asCompany(companyId, async (c) => {
      const role = await c.query('delete from access.roles where id = $1', [own]);
      const left = await c.query('select count(*)::int as n from access.role_permissions where role_id = $1', [own]);
      return [role.rowCount, left.rows[0].n];
    });
    expect(deleted).toEqual([1, 0]);
  });

  it('vai trò tuỳ biến của công ty vẫn sửa, đổi quyền, xoá được', async () => {
    const companyId = randomUUID();
    const own = await createCustomRole(companyId, ['sales.order.view']);
    const counts = await asCompany(companyId, async (c) => {
      const renamed = await c.query("update access.roles set name = 'Đổi tên' where id = $1", [own]);
      const moved = await c.query(
        "update access.role_permissions set permission_code = 'sales.order.create' where role_id = $1",
        [own],
      );
      const perms = await c.query('delete from access.role_permissions where role_id = $1', [own]);
      const role = await c.query('delete from access.roles where id = $1', [own]);
      return [renamed.rowCount, moved.rowCount, perms.rowCount, role.rowCount];
    });
    expect(counts).toEqual([1, 1, 1, 1]);
  });
});
