// Dọn nháp lời mời quá hạn (hotfix 19/11/2026): người được mời gõ email ở `/join/otp` (dòng nháp) mà tới hết hạn link
// vẫn chưa nộp mật khẩu thì xoá email, họ tên, mã OTP (`purgeExpiredDrafts`). Mỗi giờ một lượt cho cả nền tảng.
import { z } from 'zod';
import { logger } from '../../../../shared/logger.ts';
import { defineQueue, schedulePlatform, workQueue } from '../../platform/index.ts';
import { purgeExpiredDrafts } from '../repository/invitations.ts';
import { countPurged } from './metrics.ts';

export const invitationPurgeQueue = defineQueue('staff.invitation_purge', z.object({}), {
  policy: 'stately',
  attempts: 3,
  retryDelaySeconds: 300,
});

/** Phút thứ 7 mỗi giờ, giờ VN (lệch khỏi đầu giờ cho đỡ dồn việc). */
const PURGE_CRON = '7 * * * *';

export async function runInvitationPurge(): Promise<number> {
  const purged = await purgeExpiredDrafts();
  countPurged(purged);
  if (purged > 0) logger.info({ purged }, 'đã dọn nháp lời mời quá hạn');
  return purged;
}

export async function startInvitationPurge(): Promise<void> {
  await workQueue(invitationPurgeQueue, async () => {
    await runInvitationPurge();
  });
  await schedulePlatform(invitationPurgeQueue, PURGE_CRON, {}, 'all');
}
