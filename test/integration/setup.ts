import { afterAll, inject } from 'vitest';

// Đặt trước khi file test import code, vì src/shared/config/env.ts đọc biến môi trường một lần lúc import.
process.env.DATABASE_URL = inject('databaseUrl');

afterAll(async () => {
  const { closeDb } = await import('#src/shared/db/client.ts');
  const { stopJobs } = await import('#src/modules/core/platform/service/jobs/boss.ts');
  const { closeTestPool } = await import('./helpers/db.ts');
  // pg-boss dùng chung pool của app (#335): dừng nó trước rồi mới đóng pool.
  await stopJobs();
  await Promise.all([closeDb(), closeTestPool()]);
});
