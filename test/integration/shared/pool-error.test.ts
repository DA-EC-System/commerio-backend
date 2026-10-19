import { setTimeout as sleep } from 'node:timers/promises';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getDb, inTransaction } from '#src/shared/db/client.ts';
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

  it('kết nối bị cắt khi đang giữ giao dịch mà không chạy truy vấn: giao dịch lỗi, tiến trình không thoát', async () => {
    // Như relay giữ giao dịch trong lúc chờ Kafka xác nhận: client đang mượn, pool không còn nghe `error` của nó.
    const run = inTransaction(async (tx) => {
      const res = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      await testPool().query('select pg_terminate_backend($1)', [res.rows[0]!.pid]);
      await sleep(300);
    });
    await expect(run).rejects.toThrow();

    const after = await getDb().execute(sql`select 1 as ok`);
    expect(after.rows).toEqual([{ ok: 1 }]);
  });
});
