import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { BUILTIN_ROLES } from '#src/modules/core/access/domain/catalog.ts';
import { addMember, createCompany, createCustomRole } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { asCompany } from '../../helpers/rls.ts';

// #62: DB tự chặn ghi chéo công ty, không chỉ dựa vào service (đo trước ở .claude/issues/backend-62/ground-truth.md G2–G5).

/** Chạy bằng role chủ bảng (luồng đăng ký, worker: bỏ qua RLS), rồi rollback. */
async function asOwner<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await testPool().connect();
  try {
    await client.query('begin');
    return await fn(client);
  } finally {
    await client.query('rollback');
    client.release();
  }
}

const insertMemberRole = (c: pg.PoolClient, membershipId: string, roleId: string, companyId: string) =>
  c.query('insert into access.member_roles (membership_id, role_id, company_id) values ($1, $2, $3)', [
    membershipId,
    roleId,
    companyId,
  ]);

const crossCompany = { code: '23503', constraint: 'member_roles_company_fk' };

/** Hai công ty, mỗi công ty một nhân viên (vai trò Sale) và một vai trò tuỳ biến. */
async function twoCompanies() {
  const [a, b] = await Promise.all([createCompany(), createCompany()]);
  const [memberA, memberB, roleA, roleB] = await Promise.all([
    addMember(a.companyId, 'sale'),
    addMember(b.companyId, 'sale'),
    createCustomRole(a.companyId, ['catalog.product.view']),
    createCustomRole(b.companyId, ['catalog.product.view']),
  ]);
  return { a: a.companyId, b: b.companyId, memberA: memberA.membershipId, memberB: memberB.membershipId, roleA, roleB };
}

describe('gán vai trò chéo công ty bị DB từ chối (#62 AC-1)', () => {
  it('trong công ty A, gán vai trò tuỳ biến của B cho thành viên A: lỗi member_roles_company_fk', async () => {
    const t = await twoCompanies();
    await expect(asCompany(t.a, (c) => insertMemberRole(c, t.memberA, t.roleB, t.a))).rejects.toMatchObject(crossCompany);
  });

  it('chủ bảng (bỏ qua RLS) cũng bị từ chối', async () => {
    const t = await twoCompanies();
    await expect(asOwner((c) => insertMemberRole(c, t.memberA, t.roleB, t.a))).rejects.toMatchObject(crossCompany);
  });

  it('chiều ngược: gán vai trò của A cho thành viên của B (company_id = A) bị từ chối', async () => {
    const t = await twoCompanies();
    await expect(asCompany(t.a, (c) => insertMemberRole(c, t.memberB, t.roleA, t.a))).rejects.toMatchObject(crossCompany);
    await expect(asOwner((c) => insertMemberRole(c, t.memberB, t.roleA, t.a))).rejects.toMatchObject(crossCompany);
  });

  it('đổi role_id của dòng có sẵn sang vai trò của B bị từ chối', async () => {
    const t = await twoCompanies();
    await expect(
      asOwner((c) => c.query('update access.member_roles set role_id = $1 where membership_id = $2', [t.roleB, t.memberA])),
    ).rejects.toMatchObject(crossCompany);
  });

  it('vai trò có sẵn và vai trò tuỳ biến của chính công ty vẫn gán được', async () => {
    const t = await twoCompanies();
    const res = await asCompany(t.a, async (c) => {
      await insertMemberRole(c, t.memberA, BUILTIN_ROLES.admin.id, t.a);
      await insertMemberRole(c, t.memberA, t.roleA, t.a);
      return c.query('select count(*)::int as n from access.member_roles where membership_id = $1', [t.memberA]);
    });
    expect(res.rows[0].n).toBe(3);
  });
});

describe('commerio_app không sửa, không xoá được tài khoản dùng chung (#62 AC-2)', () => {
  it('UPDATE và DELETE staff.accounts bị từ chối quyền (42501); SELECT vẫn được', async () => {
    const { companyId } = await createCompany();
    const member = await addMember(companyId, 'sale');
    await expect(
      asCompany(companyId, (c) => c.query("update staff.accounts set full_name = 'Bị sửa' where id = $1", [member.accountId])),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asCompany(companyId, (c) => c.query('update staff.accounts set password_hash = null where id = $1', [member.accountId])),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asCompany(companyId, (c) => c.query('delete from staff.accounts where id = $1', [member.accountId])),
    ).rejects.toMatchObject({ code: '42501' });
    const read = await asCompany(companyId, (c) => c.query('select email from staff.accounts where id = $1', [member.accountId]));
    expect(read.rows).toEqual([{ email: member.email }]);
  });
});

describe('roles.kind ràng với company_id (#62 AC-4)', () => {
  it('công ty không tạo được vai trò kind=builtin', async () => {
    const { companyId } = await createCompany();
    await expect(
      asCompany(companyId, (c) =>
        c.query("insert into access.roles (company_id, name, kind) values ($1, 'Giả có sẵn', 'builtin')", [companyId]),
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'roles_kind_company_check' });
  });

  it('chủ bảng cũng không tạo được vai trò tuỳ biến trống công ty', async () => {
    await expect(
      asOwner((c) => c.query("insert into access.roles (company_id, name, kind) values (null, 'Tuỳ biến mồ côi', 'custom')")),
    ).rejects.toMatchObject({ code: '23514', constraint: 'roles_kind_company_check' });
  });
});
