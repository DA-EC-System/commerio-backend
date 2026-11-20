// Migration `*_bo-co-dang-huy-cu` (#427): bỏ trigger, hàm giữ cột cờ cũ; dọn hai cờ chờ sàn của đơn đã dừng trước khi thêm
// CHECK `orders_cancel_pending_open`, `orders_cancel_requested_open`. Chạy câu dữ liệu trong giao dịch rồi rollback.
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { testPool } from '../../helpers/db.ts';

const MIGRATIONS = join(import.meta.dirname, '../../../../db/migrations');

const statements = (slug: string): string[] => {
  const file = readdirSync(MIGRATIONS).find((f) => f.endsWith(`_${slug}.sql`));
  if (!file) throw new Error(`Không thấy migration *_${slug}.sql`);
  return readFileSync(join(MIGRATIONS, file), 'utf8').split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);
};

/** Lỗi khoá: hết `lock_timeout` (`55P03`) hay bị chọn huỷ vì deadlock (`40P01`). */
const lockFailure = (err: unknown) => ['55P03', '40P01'].includes((err as { code?: string }).code ?? '');

/**
 * Chạy `fn` trong giao dịch rồi rollback. Dữ liệu cần dọn (đơn đã dừng mang cờ) nay bị CHECK chặn, nên giao dịch bỏ hai
 * CHECK trước (khoá `AccessExclusive`, chờ tối đa 500 ms rồi chạy lại cả khối để file khác không xếp hàng lâu).
 */
async function rolledBack(fn: (c: pg.PoolClient) => Promise<void>) {
  for (let attempt = 1; ; attempt += 1) {
    const c = await testPool().connect();
    try {
      await c.query('begin');
      await c.query(`set local lock_timeout = '500ms'`);
      await c.query(
        'alter table "order".orders drop constraint orders_cancel_pending_open, drop constraint orders_cancel_requested_open',
      );
      await fn(c);
      return;
    } catch (err) {
      if (!lockFailure(err) || attempt >= 20) throw err;
    } finally {
      await c.query('rollback');
      c.release();
    }
    await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
  }
}

const insertOrder = (c: pg.PoolClient, companyId: string, status: string) =>
  c
    .query<{ id: string }>(
      `insert into "order".orders (company_id, code, source, payment_method, status, outcome, cancel_pending, cancel_requested, subtotal, total)
       values ($1, $2, 'manual', 'prepaid', $3, $4, true, true, 0, 0) returning id`,
      [companyId, `DH-${randomUUID().slice(0, 8)}`, status, status === 'completed' ? 'full' : null],
    )
    .then((r) => r.rows[0]!.id);

describe('migration bỏ cờ Đang huỷ cũ (#427)', () => {
  it('đơn đã dừng bỏ hai cờ, đơn còn mở giữ; chạy lại cũng vậy', async () => {
    const company = randomUUID();
    await rolledBack(async (c) => {
      const ids = {
        unpaid: await insertOrder(c, company, 'unpaid'),
        processing: await insertOrder(c, company, 'processing'),
        completed: await insertOrder(c, company, 'completed'),
        cancelled: await insertOrder(c, company, 'cancelled'),
      };
      const data = statements('bo-co-dang-huy-cu').filter((s) => !/\bdrop (trigger|function)\b/i.test(s));
      expect(data).toHaveLength(1);
      for (let run = 0; run < 2; run += 1) await c.query(data[0]!);
      const { rows } = await c.query<{ id: string; cancel_pending: boolean; cancel_requested: boolean }>(
        'select id, cancel_pending, cancel_requested from "order".orders where company_id = $1',
        [company],
      );
      const flags = (id: string) => rows.find((r) => r.id === id);
      expect(flags(ids.unpaid)).toMatchObject({ cancel_pending: true, cancel_requested: true });
      expect(flags(ids.processing)).toMatchObject({ cancel_pending: true, cancel_requested: true });
      expect(flags(ids.completed)).toMatchObject({ cancel_pending: false, cancel_requested: false });
      expect(flags(ids.cancelled)).toMatchObject({ cancel_pending: false, cancel_requested: false });
    });
  });

  it('không còn trigger, hàm giữ cột cờ cũ, không còn cột cancelling', async () => {
    const { rows } = await testPool().query<{ triggers: number; functions: number; columns: number }>(
      `select (select count(*)::int from pg_trigger where tgname = 'orders_sync_cancel_pending') as triggers,
              (select count(*)::int from pg_proc where proname = 'orders_sync_cancel_pending') as functions,
              (select count(*)::int from information_schema.columns
                where table_schema = 'order' and table_name = 'orders' and column_name = 'cancelling') as columns`,
    );
    expect(rows[0]).toEqual({ triggers: 0, functions: 0, columns: 0 });
  });
});
