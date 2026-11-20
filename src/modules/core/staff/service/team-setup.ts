// Cổng cho insight onboarding (#461, Documents/21 mục 11.3, 23): công ty đã có người ngoài CEO hay đã mời ai chưa.
import { BUILTIN_ROLES, membershipIdsWithRole } from '../../access/index.ts';
import { activeMembershipIds } from '../repository/accounts.ts';
import { countLiveInvitations } from '../repository/invitations.ts';

export interface TeamSetupState {
  /** Thành viên đang hoạt động không mang vai trò CEO */
  otherActiveMembers: number;
  /** Lời mời mọi trạng thái trừ `revoked` */
  invitations: number;
}

/** Chạy trong `withCompany` của bên gọi. */
export async function teamSetupState(): Promise<TeamSetupState> {
  const active = await activeMembershipIds();
  const ceos = new Set(await membershipIdsWithRole(BUILTIN_ROLES.ceo.id));
  return { otherActiveMembers: active.filter((id) => !ceos.has(id)).length, invitations: await countLiveInvitations() };
}
