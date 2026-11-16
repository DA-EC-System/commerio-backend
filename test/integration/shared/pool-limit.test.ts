import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as Boss from '#src/modules/core/platform/service/jobs/boss.ts';
import type * as DbClient from '#src/shared/db/client.ts';

// Session pooler (Supabase) giới hạn tổng số kết nối của mọi tiến trình; pool vượt trần thì pooler từ chối và request
// trả 500 (#335). Pool phải giữ đúng `DB_POOL_MAX`, request dư xếp hàng chờ, chờ quá `DB_CONNECT_TIMEOUT_MS` thì lỗi.
// env.ts đọc biến một lần lúc import nên đặt biến rồi mới import động (file test chạy trong tiến trình riêng).
process.env.DB_POOL_MAX = '2';
process.env.DB_CONNECT_TIMEOUT_MS = '500';

let client: typeof DbClient;
let boss: typeof Boss;
beforeAll(async () => {
  client = await import('#src/shared/db/client.ts');
  boss = await import('#src/modules/core/platform/service/jobs/boss.ts');
});

const pidIn = (companyId: string, holdMs = 50) =>
  client.withCompany(companyId, async (tx) => {
    const res = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid, pg_sleep(${holdMs / 1000})`);
    return res.rows[0]!.pid;
  });

/** Mở `n` giao dịch giữ kết nối; trả về khi cả `n` đã lấy được kết nối (không đoán bằng thời gian). */
async function holdConnections(n: number) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const acquired: Promise<void>[] = [];
  const holders = Array.from({ length: n }, () => {
    let got!: () => void;
    acquired.push(new Promise<void>((resolve) => (got = resolve)));
    return client.withCompany(randomUUID(), () => {
      got();
      return held;
    });
  });
  await Promise.all(acquired);
  return {
    async release() {
      release();
      await Promise.all(holders);
    },
  };
}

describe('trần kết nối của pool (#335)', () => {
  it('8 request cùng lúc với DB_POOL_MAX=2: đều xong, chỉ dùng tối đa 2 kết nối', async () => {
    const pids = await Promise.all(Array.from({ length: 8 }, () => pidIn(randomUUID())));
    expect(pids).toHaveLength(8);
    expect(new Set(pids).size).toBeLessThanOrEqual(2);
  });

  it('pool đầy quá DB_CONNECT_TIMEOUT_MS: request chờ báo lỗi chứ không treo; trả kết nối thì chạy tiếp', async () => {
    const holding = await holdConnections(2);
    expect(client.sharedPool().totalCount).toBe(2);
    expect(client.sharedPool().idleCount).toBe(0);

    await expect(pidIn(randomUUID())).rejects.toThrow(/timeout/i);

    await holding.release();
    await expect(pidIn(randomUUID())).resolves.toBeTypeOf('number');
  });

  it('pg-boss dùng chung pool của app: pool đầy thì việc của pg-boss xếp hàng, không mở thêm kết nối', async () => {
    const holding = await holdConnections(2);

    const queues = boss.jobBoss().then((b) => b.getQueues());
    // pg-boss phải chờ trong hàng của chính pool này, không tự mở kết nối thứ ba
    await vi.waitFor(() => expect(client.sharedPool().waitingCount).toBeGreaterThan(0), { timeout: 400, interval: 5 });
    expect(client.sharedPool().totalCount).toBe(2);

    await holding.release();
    await expect(queues).resolves.toBeInstanceOf(Array);
    expect(client.sharedPool().totalCount).toBeLessThanOrEqual(2);
  });
});
