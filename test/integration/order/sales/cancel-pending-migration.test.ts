// Migration dọn cờ Đang huỷ kẹt (test đêm 18/11/2026: DH-B03, KH-B09): chạy câu SQL của file `*_dang-huy-du-lieu.sql`
// trong giao dịch rồi rollback, như `line-cancel-migration.test.ts`. File chạy trước migration đổi tên cột nên còn gọi
// `cancelling`: giao dịch tạm đổi tên lại và bỏ hai CHECK mới để dựng dữ liệu cũ.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { createOrder } from '../../helpers/sales.ts';

const MIGRATIONS = join(import.meta.dirname, '../../../../db/migrations');

const statements = (): string[] => {
  const file = readdirSync(MIGRATIONS).find((f) => f.endsWith('_dang-huy-du-lieu.sql'));
  if (!file) throw new Error('Không thấy migration *_dang-huy-du-lieu.sql');
  return readFileSync(join(MIGRATIONS, file), 'utf8').split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);
};

async function rolledBack(fn: (c: pg.PoolClient) => Promise<void>) {
  const c = await testPool().connect();
  try {
    await c.query('begin');
    await c.query(`alter table "order".orders drop constraint orders_cancel_pending_open, drop constraint orders_cancel_requested_open`);
    await c.query(`alter table "order".orders rename column cancel_pending to cancelling`);
    await fn(c);
  } finally {
    await c.query('rollback');
    c.release();
  }
}

describe('dọn cờ Đang huỷ kẹt (DH-B03, KH-B09)', () => {
  it('đơn đã dừng bỏ cờ chờ sàn; đơn có món đã huỷ bỏ cờ; đơn chờ sàn thật giữ cờ; tiền đơn huỷ một phần món tính lại', async () => {
    const { companyId } = await createCompany();
    const { variantId } = await createVariant(companyId);
    const order = async (lines: number) =>
      (await createOrder(companyId, { lines: Array.from({ length: lines }, () => ({ variantId, quantity: 1, unitPrice: 100000 })), source: 'marketplace' })).orderId;
    const cancelledStuck = await order(1);
    const completedRequested = await order(1);
    const partial = await order(2);
    const waiting = await order(1);
    const allCancelled = await order(1);

    await rolledBack(async (c) => {
      await c.query(`update "order".orders set status = 'cancelled', cancelling = true where id = $1`, [cancelledStuck]);
      await c.query(
        `update "order".orders set status = 'completed', outcome = 'full', cancel_requested = true, cancelling = true where id = $1`,
        [completedRequested],
      );
      await c.query(`update "order".orders set status = 'processing', cancelling = true, shipping_fee = 15000 where id = any($1::uuid[])`, [[partial, waiting, allCancelled]]);
      await c.query(
        `update "order".order_lines set seller_discount = 10000, platform_discount = 5000 where order_id = $1`,
        [partial],
      );
      // Món đầu của đơn hai món đã huỷ; đơn huỷ hết món giữ tiền lúc đặt.
      await c.query(
        `update "order".order_lines set cancelled_qty = quantity
         where id = (select id from "order".order_lines where order_id = $1 order by id limit 1)`,
        [partial],
      );
      await c.query(`update "order".order_lines set cancelled_qty = quantity where order_id = $1`, [allCancelled]);
      const totalsBefore = (await c.query('select subtotal, total from "order".orders where id = $1', [allCancelled])).rows[0];

      for (const s of statements()) await c.query(s);

      const row = async (id: string) =>
        (
          await c.query<{ status: string; cancelling: boolean; cancel_requested: boolean; subtotal: string; seller_discount: string; platform_discount: string; total: string }>(
            'select status, cancelling, cancel_requested, subtotal, seller_discount, platform_discount, total from "order".orders where id = $1',
            [id],
          )
        ).rows[0]!;
      expect(await row(cancelledStuck)).toMatchObject({ status: 'cancelled', cancelling: false });
      expect(await row(completedRequested)).toMatchObject({ status: 'completed', cancelling: false, cancel_requested: false });
      expect(await row(partial)).toMatchObject({
        cancelling: false,
        subtotal: '100000.00',
        seller_discount: '10000.00',
        platform_discount: '5000.00',
        // 100.000 − 10.000 − 5.000 + phí ship 15.000
        total: '100000.00',
      });
      expect(await row(waiting)).toMatchObject({ status: 'processing', cancelling: true });
      expect(await row(allCancelled)).toMatchObject({ cancelling: false, subtotal: totalsBefore.subtotal, total: totalsBefore.total });
    });
  });
});
