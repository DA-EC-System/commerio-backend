import { setTimeout as sleep } from 'node:timers/promises';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getDb } from '#src/shared/db/client.ts';
import { testPool } from '../helpers/db.ts';

// Kết nối rảnh trong pool bị PostgreSQL cắt (restart, failover, idle timeout): pool phát `error`.
// Không có listener thì EventEmitter ném và tiến trình (worker) thoát.
describe('pool PostgreSQL', () => {
  it('kết nối rảnh bị cắt không làm tiến trình thoát, truy vấn sau vẫn chạy', async () => {
    const before = await getDb().execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
    const pid = before.rows[0]!.pid;

    // Kết nối vừa dùng đã về pool ở trạng thái rảnh; cắt nó từ phía server.
    await testPool().query('select pg_terminate_backend($1)', [pid]);
    await sleep(300);

    const after = await getDb().execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
    expect(after.rows[0]!.pid).not.toBe(pid);
  });
});
