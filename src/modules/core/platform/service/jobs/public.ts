// Khởi động hàng việc nền trong worker (#102). Module khác đăng ký việc qua core/index.ts.
import type { ModuleContext } from '../../../../../shared/module.ts';
import { startOutboxBackground } from '../outbox/public.ts';
import { jobBoss, runJobsAsWorker, stopJobs } from './boss.ts';

/** `startBackground` của platform: relay outbox, consumer, rồi hàng việc nền (platform khởi động trước mọi module). */
export async function startPlatformBackground(ctx: ModuleContext): Promise<() => Promise<void>> {
  runJobsAsWorker();
  await jobBoss();
  const stopOutbox = await startOutboxBackground(ctx);
  return async () => {
    await Promise.all([stopOutbox(), stopJobs()]);
  };
}
