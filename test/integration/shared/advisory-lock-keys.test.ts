import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { lockInvoiceOfOrder } from '#src/modules/finance/finance/repository/invoices.ts';
import { tryLockRelay } from '#src/modules/core/platform/repository/outbox.ts';
import { getDb, inTransaction } from '#src/shared/db/client.ts';
import { pgError } from '#src/shared/db/pg-error.ts';
import { testPool } from '../helpers/db.ts';

// Khoá advisory 64 bit (#63 B17): mọi chỗ khoá dùng `hashtextextended(<khoá>, 0)`. Không thử va chạm băm được, nên kiểm
// (1) khoá thật trong `pg_locks` là số 64 bit đó, (2) hai nơi dùng chung khoá vẫn loại trừ nhau, và chỉ khi cùng hàm băm.

/** Khoá advisory phiên hiện tại đang giữ: `pg_locks` tách khoá bigint thành `classid` (32 bit cao) và `objid`. */
async function heldKeys(): Promise<string[]> {
  const result = await getDb().execute<{ key: string }>(
    sql`select ((classid::bigint << 32) | objid::bigint)::text as key from pg_locks
        where locktype = 'advisory' and pid = pg_backend_pid()`,
  );
  return result.rows.map((row) => row.key);
}

async function extendedKey(key: string): Promise<string> {
  const { rows } = await testPool().query<{ key: string }>('select hashtextextended($1, 0)::text as key', [key]);
  return rows[0]!.key;
}

const holders: { release: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const holder of holders.splice(0)) await holder.release();
});

/** Phiên khác giữ khoá giao dịch `<hash>(key)` tới cuối test. */
async function holdElsewhere(hash: 'hashtext($1)' | 'hashtextextended($1, 0)', key: string): Promise<void> {
  const client = await testPool().connect();
  await client.query('begin');
  await client.query(`select pg_advisory_xact_lock(${hash})`, [key]);
  holders.push({
    release: async () => {
      await client.query('rollback');
      client.release();
    },
  });
}

describe('khoá advisory 64 bit (#63 B17)', () => {
  it('lockInvoiceOfOrder và tryLockRelay giữ đúng khoá hashtextextended(…, 0)', async () => {
    const orderId = randomUUID();
    const prefix = `t${randomUUID().slice(0, 8)}`;
    const keys = await inTransaction(async () => {
      await lockInvoiceOfOrder(orderId);
      expect(await tryLockRelay(prefix)).toBe(true);
      return heldKeys();
    });
    expect(keys).toEqual(
      expect.arrayContaining([await extendedKey(`finance.invoice:${orderId}`), await extendedKey(`platform.outbox_relay:${prefix}`)]),
    );
  });

  it('phiên khác giữ khoá 64 bit của relay → tryLockRelay trả false (cùng khoá với test S4 của kafka.test.ts)', async () => {
    const prefix = `t${randomUUID().slice(0, 8)}`;
    await holdElsewhere('hashtextextended($1, 0)', `platform.outbox_relay:${prefix}`);
    expect(await inTransaction(() => tryLockRelay(prefix))).toBe(false);
  });

  it('phiên khác giữ khoá 64 bit của hoá đơn → lockInvoiceOfOrder phải chờ (hết lock_timeout, 55P03)', async () => {
    const orderId = randomUUID();
    await holdElsewhere('hashtextextended($1, 0)', `finance.invoice:${orderId}`);
    const err = await inTransaction(async () => {
      await getDb().execute(sql`set local lock_timeout = '300ms'`);
      return lockInvoiceOfOrder(orderId).then(
        () => null,
        (e: unknown) => e,
      );
    });
    expect(pgError(err).code).toBe('55P03');
  });

  it('khoá hashtext 32 bit cũ không chặn: hai nơi dùng chung khoá phải đổi hàm băm cùng nhau', async () => {
    const orderId = randomUUID();
    const prefix = `t${randomUUID().slice(0, 8)}`;
    await holdElsewhere('hashtext($1)', `finance.invoice:${orderId}`);
    await holdElsewhere('hashtext($1)', `platform.outbox_relay:${prefix}`);
    await inTransaction(async () => {
      await getDb().execute(sql`set local lock_timeout = '300ms'`);
      await lockInvoiceOfOrder(orderId);
      expect(await tryLockRelay(prefix)).toBe(true);
    });
  });
});
