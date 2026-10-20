import type { PoolClient } from 'pg';
import { testPool } from './db.ts';

// Dựng chạy đua tất định: một giao dịch giữ khoá, các request đua bị chặn sau nó, đếm đủ rồi mới commit.

/**
 * Số phiên đang chờ sau `holderPid`: chờ thẳng, cộng phiên chờ sau các phiên đó (khoá dòng xếp hàng: phiên sau bị
 * phiên trước chặn, không phải `holder`). Tầng một chỉ có phiên chờ `holder` của lượt này; tầng hai có thể lẫn phiên của
 * file khác nếu nó chờ đúng khoá mà request đua đang giữ (hiếm), khi đó số đếm lệch và hàm gọi ném lỗi rõ.
 */
async function blockedBehind(holderPid: number): Promise<number> {
  const r = await testPool().query<{ n: number }>(
    `with direct as (select pid from pg_stat_activity where pg_blocking_pids(pid) @> array[$1]::int[])
     select (select count(*) from direct)::int + (select count(*) from pg_stat_activity
       where pid not in (select pid from direct) and pg_blocking_pids(pid) && array(select pid from direct))::int as n`,
    [holderPid],
  );
  return r.rows[0]!.n;
}

/**
 * Mở giao dịch, chạy `lock` trên nó, rồi chạy `start` (các request đua; phải thật sự gửi, vd `Promise.all`). Chờ tới khi
 * đúng `blocked` phiên bị chặn sau giao dịch đó (tối đa ~5 s, quá thì ném lỗi), commit, trả kết quả của `start`.
 */
export async function raceBehindLock<T>(lock: (holder: PoolClient) => Promise<unknown>, blocked: number, start: () => Promise<T>): Promise<T> {
  const holder = await testPool().connect();
  try {
    await holder.query('begin');
    await lock(holder);
    const pid = (await holder.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
    const pending = start();
    pending.catch(() => undefined); // lỗi của request đọc ở `await pending` bên dưới
    let n = await blockedBehind(pid);
    for (let i = 0; i < 100 && n < blocked; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      n = await blockedBehind(pid);
    }
    if (n !== blocked) throw new Error(`Có ${n} phiên chờ sau giao dịch giữ khoá, cần ${blocked}`);
    await holder.query('commit');
    return await pending;
  } finally {
    // Hỏng giữa chừng thì nhả khoá để request còn treo tự xong, không trả kết nối đang giữ khoá về pool.
    await holder.query('rollback').catch(() => undefined);
    holder.release();
  }
}
