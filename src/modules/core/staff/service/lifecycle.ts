// Phần của staff trong nền vòng đời (#101): ai được tự duyệt, lịch sử trạng thái kèm tên người.
// Lịch sử ghi ở platform; tên người nằm ở bảng của staff, platform không import staff được (vòng).
import { memberRolesOf } from '../../access/index.ts';
import { listTransitions, type TransitionSource } from '../../platform/index.ts';
import { countActiveMembers, findAccountSummaries, findMemberByAccount } from '../repository/accounts.ts';

/**
 * Được tự làm bước cần người thứ hai: người làm là CEO, hoặc khách thuê chỉ có một thành viên đang hoạt động (cá nhân,
 * hộ kinh doanh tự bán). Documents/25 §11, Documents/19 dòng 38. Chạy trong `withCompany` của bên gọi.
 */
export async function canSelfApprove(accountId: string): Promise<boolean> {
  const member = await findMemberByAccount(accountId);
  if (!member || member.status !== 'active') return false;
  const roles = (await memberRolesOf([member.membershipId])).get(member.membershipId) ?? [];
  return roles.some((r) => r.isCeo) || (await countActiveMembers()) === 1;
}

/** `StatusChange` của Documents/21 mục 14.1. */
export interface StatusChange {
  at: Date;
  from: string | null;
  to: string;
  by: { id: string; name: string } | null;
  source: TransitionSource;
  reason: string | null;
}

/** Lịch sử trạng thái của một thực thể, cũ trước, để trả trong `statusHistory` của chi tiết bản ghi. */
export async function getStatusHistory(entityType: string, entityId: string): Promise<StatusChange[]> {
  const rows = await listTransitions(entityType, entityId);
  const names = new Map(
    (await findAccountSummaries(rows.flatMap((r) => (r.actorId ? [r.actorId] : [])))).map((a) => [a.id, a.fullName]),
  );
  return rows.map(({ at, from, to, actorId, source, reason }) => ({
    at,
    from,
    to,
    by: actorId ? { id: actorId, name: names.get(actorId) ?? '' } : null,
    source,
    reason,
  }));
}
