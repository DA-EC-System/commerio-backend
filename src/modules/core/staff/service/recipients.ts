// Người nhận thư theo vai trò cho module khác (#312: channel gửi thư báo gian hàng mất uỷ quyền cho CEO, Admin).
import { membershipIdsWithRole } from '../../access/index.ts';
import { activeMemberEmails } from '../repository/accounts.ts';

/**
 * Email của thành viên đang hoạt động trong công ty hiện tại có ít nhất một vai trò trong `roleIds`, không gồm quản trị
 * nền tảng, sắp theo email, không trùng. Chạy trong `withCompany`: RLS chỉ cho thấy thành viên của công ty đó.
 */
export async function activeMemberEmailsWithRoles(roleIds: readonly string[]): Promise<string[]> {
  const membershipIds: string[] = [];
  for (const roleId of new Set(roleIds)) membershipIds.push(...(await membershipIdsWithRole(roleId)));
  return activeMemberEmails(membershipIds);
}
