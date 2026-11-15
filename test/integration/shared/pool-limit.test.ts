import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import type * as DbClient from '#src/shared/db/client.ts';

// Session pooler (Supabase) giới hạn tổng số kết nối của mọi tiến trình; pool vượt trần thì pooler từ chối và request
// trả 500 (#335). Pool phải giữ đúng `DB_POOL_MAX`, request dư xếp hàng chờ, chờ quá `DB_CONNECT_TIMEOUT_MS` thì lỗi.
// env.ts đọc biến một lần lúc import nên đặt biến rồi mới import động (file test chạy trong tiến trình riêng).
process.env.DB_POOL_MAX = '2';
process.env.DB_CONNECT_TIMEOUT_MS = '500';

let client: typeof DbClient;
beforeAll(async () => {
  client = await import('#src/shared/db/client.ts');
});

const pidIn = (companyId: string, holdMs = 50) =>
  client.withCompany(companyId, async (tx) => {
    const res = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid, pg_sleep(${holdMs / 1000})`);
    return res.rows[0]!.pid;
  });

describe('trần kết nối của pool (#335)', () => {
  it('8 request cùng lúc với DB_POOL_MAX=2: đều xong, chỉ dùng tối đa 2 kết nối', async () => {
    const pids = await Promise.all(Array.from({ length: 8 }, () => pidIn(randomUUID())));
    expect(pids).toHaveLength(8);
    expect(new Set(pids).size).toBeLessThanOrEqual(2);
  });

  it('pool đầy quá DB_CONNECT_TIMEOUT_MS: request chờ báo lỗi chứ không treo; trả kết nối thì chạy tiếp', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const holders = Array.from({ length: 2 }, () => client.withCompany(randomUUID(), () => held));
    // Chờ hai giao dịch lấy được kết nối rồi mới gửi request thứ ba
    await new Promise((resolve) => setTimeout(resolve, 100));

    const started = Date.now();
    await expect(pidIn(randomUUID())).rejects.toThrow(/timeout/i);
    expect(Date.now() - started).toBeLessThan(3000);

    release();
    await Promise.all(holders);
    await expect(pidIn(randomUUID())).resolves.toBeTypeOf('number');
  });
});
