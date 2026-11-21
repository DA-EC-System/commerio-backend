// Khởi động hàng việc nền trong worker (#102). Module khác đăng ký việc qua core/index.ts.
import type { ModuleContext } from '../../../../../shared/module.ts';
import { startOutboxBackground } from '../outbox/public.ts';
import { handleTaxCodeReleasedMail, taxCodeReleasedMailQueue } from '../tax-code-release.ts';
import { startTestCompanyCleanup } from '../test-company.ts';
import { jobBoss, runJobsAsWorker, stopJobs } from './boss.ts';
import { workQueue } from './queues.ts';

/** `startBackground` của platform: relay outbox, consumer, rồi hàng việc nền (platform khởi động trước mọi module). */
export async function startPlatformBackground(ctx: ModuleContext): Promise<() => Promise<void>> {
  runJobsAsWorker();
  await jobBoss();
  const stopOutbox = await startOutboxBackground(ctx);
  // #459: thư báo CEO khi quản trị nền tảng gỡ mã số thuế
  await workQueue(taxCodeReleasedMailQueue, (data) => handleTaxCodeReleasedMail(data));
  // Dọn công ty thử của e2e quá 6 giờ (chỉ server bật đăng ký thử)
  await startTestCompanyCleanup();
  return async () => {
    await Promise.all([stopOutbox(), stopJobs()]);
  };
}
