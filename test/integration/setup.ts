import { afterAll, inject } from 'vitest';

// Đặt trước khi file test import code, vì src/shared/config/env.ts đọc biến môi trường một lần lúc import.
process.env.DATABASE_URL = inject('databaseUrl');

afterAll(async () => {
  const { closeDb } = await import('#src/shared/db/client.ts');
  const { closeTestPool } = await import('./helpers/db.ts');
  await Promise.all([closeDb(), closeTestPool()]);
});
