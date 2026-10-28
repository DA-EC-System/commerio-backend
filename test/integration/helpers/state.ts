import { testPool } from './db.ts';

// Đổi trạng thái thẳng trong DB giữa hai lần gọi API, như khi quản trị viên khác vừa thao tác (token vẫn còn hạn).

export async function lockCompany(companyId: string): Promise<void> {
  await testPool().query("update core.companies set status = 'locked' where id = $1", [companyId]);
}

export async function suspendMembership(membershipId: string): Promise<void> {
  await testPool().query("update core.memberships set status = 'suspended' where id = $1", [membershipId]);
}

export async function setModuleEnabled(companyId: string, moduleCode: string, enabled: boolean): Promise<void> {
  await testPool().query(
    `insert into core.company_modules (company_id, module_code, enabled) values ($1, $2, $3)
     on conflict (company_id, module_code) do update set enabled = excluded.enabled`,
    [companyId, moduleCode, enabled],
  );
}

/** Bỏ một quyền khỏi vai trò. Chỉ dùng cho vai trò tuỳ biến: vai trò có sẵn dùng chung mọi file test. */
export async function revokePermission(roleId: string, permission: string): Promise<void> {
  await testPool().query('delete from core.role_permissions where role_id = $1 and permission_code = $2', [
    roleId,
    permission,
  ]);
}
