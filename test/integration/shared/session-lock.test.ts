import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { withSessionLock } from '#src/shared/db/client.ts';
import { testPool } from '../helpers/db.ts';

// `withSessionLock` (#201, review #217 mục 5): chờ khoá bằng `pg_try_advisory_lock` lặp có nghỉ, không chặn giữ kết nối;
// kết nối lấy được khoá giữ tới khi `fn` xong rồi mới nhả.

/** Số phiên đang bị chặn chờ khoá `key` (`pg_advisory_lock` chặn sẽ hiện ở đây). Chỉ đếm khoá của test: file khác chạy song song. */
async function blockedOn(key: string): Promise<number> {
  const { rows } = await testPool().query<{ n: number }>(
    `select count(*)::int as n from pg_locks
      where locktype = 'advisory' and not granted and ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`,
    [key],
  );
  return rows[0]!.n;
}

/** Số phiên đang giữ khoá phiên `key`. */
async function holders(key: string): Promise<number> {
  const { rows } = await testPool().query<{ n: number }>(
    `select count(*)::int as n from pg_locks
      where locktype = 'advisory' and granted and ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`,
    [key],
  );
  return rows[0]!.n;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe('withSessionLock', () => {
  it('không waitMs: phiên khác đang giữ thì trả busy ngay, như trước', async () => {
    const key = `test.lock:${randomUUID()}`;
    const gate = deferred();
    const entered = deferred();
    const first = withSessionLock(key, async () => {
      entered.resolve();
      await gate.promise;
      return 'a';
    });
    await entered.promise;
    const started = Date.now();
    expect(await withSessionLock(key, async () => 'b')).toBe('busy');
    expect(Date.now() - started).toBeLessThan(1_000);
    gate.resolve();
    expect(await first).toBe('a');
    expect(await holders(key)).toBe(0);
  });

  it('có waitMs: chờ bằng thử lặp, không phiên nào bị chặn trên khoá; người giữ nhả thì lấy được và chạy fn', async () => {
    const key = `test.lock:${randomUUID()}`;
    const gate = deferred();
    const entered = deferred();
    const order: string[] = [];
    const first = withSessionLock(key, async () => {
      entered.resolve();
      await gate.promise;
      order.push('first');
    });
    await entered.promise;
    const second = withSessionLock(key, async () => {
      // Đang giữ khoá trên đúng một phiên suốt fn.
      expect(await holders(key)).toBe(1);
      order.push('second');
      return 'ok';
    }, { waitMs: 5_000 });
    // Trong lúc chờ: không có phiên nào chặn trên `pg_advisory_lock` (kết nối trả về pool giữa các lần thử).
    try {
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 60));
        expect(await blockedOn(key)).toBe(0);
        expect(await holders(key)).toBe(1);
      }
    } finally {
      gate.resolve();
    }
    expect(await second).toBe('ok');
    await first;
    expect(order).toEqual(['first', 'second']);
    expect(await holders(key)).toBe(0);
  });

  it('có waitMs: hết hạn mà chưa có khoá thì busy, không chạy fn', async () => {
    const key = `test.lock:${randomUUID()}`;
    const gate = deferred();
    const entered = deferred();
    const first = withSessionLock(key, async () => {
      entered.resolve();
      await gate.promise;
    });
    await entered.promise;
    let ran = false;
    const started = Date.now();
    const result = await withSessionLock(key, async () => {
      ran = true;
    }, { waitMs: 300 });
    const waited = Date.now() - started;
    expect(result).toBe('busy');
    expect(ran).toBe(false);
    expect(waited).toBeGreaterThanOrEqual(250);
    expect(waited).toBeLessThan(2_000);
    gate.resolve();
    await first;
  });

  it('fn ném lỗi thì vẫn nhả khoá', async () => {
    const key = `test.lock:${randomUUID()}`;
    await expect(withSessionLock(key, async () => Promise.reject(new Error('hỏng')), { waitMs: 100 })).rejects.toThrow('hỏng');
    expect(await holders(key)).toBe(0);
    expect(await withSessionLock(key, async () => 'lại', { waitMs: 100 })).toBe('lại');
  });
});
