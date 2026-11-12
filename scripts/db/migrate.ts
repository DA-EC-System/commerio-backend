// npm run db:migrate          chạy migration, dừng nếu có migration lệch thứ tự (drizzle sẽ bỏ qua im lặng)
// npm run db:migrate:check    chỉ đọc: liệt kê đã chạy, chưa chạy, lệch thứ tự; mã thoát 1 nếu có lệch thứ tự
// Chuỗi kết nối: DATABASE_URL (.env, hoặc .env.staging với các lệnh :staging). Xem db/CLAUDE.md.
import pg from 'pg';
import { formatStatus, inspect, MigrationOrderError, migrateGuarded } from './lib/guard.ts';
import { blockingMessage } from './lib/status.ts';
import { MIGRATIONS_DIR } from './lib/journal.ts';

const checkOnly = process.argv.includes('--check');
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Thiếu DATABASE_URL.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const opts = { migrationsFolder: MIGRATIONS_DIR };
  if (checkOnly) {
    const status = await inspect(client, opts);
    console.log(formatStatus(status, true));
    const blocking = blockingMessage(status);
    if (blocking) console.error(`\n${blocking}`);
    process.exitCode = blocking ? 1 : 0;
  } else {
    await migrateGuarded(client, opts);
  }
} catch (error) {
  console.error(error instanceof MigrationOrderError ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.end();
}
