import { describe, expect, it } from 'vitest';
import { BUILTIN_ROLES } from '#src/modules/access/domain/catalog.ts';
import { findRolesWithPermissions, memberRolesOf, replaceMemberRoles } from '#src/modules/access/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { addMember, createCompany, createCustomRole } from '../helpers/company.ts';
import { testPool } from '../helpers/db.ts';

const db = testPool();
const roleIdsOf = async (membershipId: string) =>
  (await db.query<{ role_id: string }>('select role_id from access.member_roles where membership_id = $1 order by role_id', [membershipId]))
    .rows.map((r) => r.role_id);

// Hàm vai trò access cho staff gọi (#7 [B]), chạy trong withCompany của bên gọi.
describe('hàm vai trò cho staff', () => {
  it('findRolesWithPermissions trả vai trò có sẵn và của công ty, không trả vai trò tuỳ biến của công ty khác', async () => {
    const a = await createCompany();
    const b = await createCompany();
    const roleA = await createCustomRole(a.companyId, ['sales.order.view']);
    const roleB = await createCustomRole(b.companyId, ['sales.order.view']);
    const found = await withCompany(a.companyId, () =>
      findRolesWithPermissions([BUILTIN_ROLES.ceo.id, BUILTIN_ROLES.sale.id, roleA, roleB]),
    );
    expect(found.map((r) => r.id).sort()).toEqual([BUILTIN_ROLES.ceo.id, BUILTIN_ROLES.sale.id, roleA].sort());
    expect(found.find((r) => r.id === BUILTIN_ROLES.ceo.id)?.isCeo).toBe(true);
    expect(found.find((r) => r.id === roleA)).toMatchObject({ isCeo: false, permissions: ['sales.order.view'] });
    expect(found.find((r) => r.id === BUILTIN_ROLES.sale.id)?.permissions).toEqual([...BUILTIN_ROLES.sale.permissions].sort());
  });

  it('memberRolesOf gom vai trò theo membership', async () => {
    const a = await createCompany();
    const member = await addMember(a.companyId, 'sale');
    const roles = await withCompany(a.companyId, () => memberRolesOf([member.membershipId]));
    expect(roles.get(member.membershipId)?.map((r) => r.id)).toEqual([BUILTIN_ROLES.sale.id]);
  });

  it('replaceMemberRoles thay trọn vai trò', async () => {
    const a = await createCompany();
    const member = await addMember(a.companyId, 'sale');
    const custom = await createCustomRole(a.companyId, ['sales.order.view']);
    await withCompany(a.companyId, () => replaceMemberRoles(member.membershipId, a.companyId, [BUILTIN_ROLES.kho.id, custom]));
    expect(await roleIdsOf(member.membershipId)).toEqual([BUILTIN_ROLES.kho.id, custom].sort());
  });

  it('gọi ngoài withCompany thì ném lỗi lập trình', async () => {
    await expect(findRolesWithPermissions([BUILTIN_ROLES.sale.id])).rejects.toThrow(/withCompany/);
    await expect(memberRolesOf([])).rejects.toThrow(/withCompany/);
    await expect(replaceMemberRoles(BUILTIN_ROLES.sale.id, BUILTIN_ROLES.sale.id, [])).rejects.toThrow(/withCompany/);
  });
});
