// Migration dọn cờ Đang huỷ kẹt (test đêm 18/11/2026: DH-B03, KH-B09), chép cờ cũ sang `cancel_pending` và trigger giữ hai
// cột bằng nhau (#417): chạy câu SQL của từng file trong giao dịch rồi rollback, như `line-cancel-migration.test.ts`.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { createOrder } from '../../helpers/sales.ts';

const MIGRATIONS = join(import.meta.dirname, '../../../../db/migrations');

const statements = (slug: string): string[] => {
  const file = readdirSync(MIGRATIONS).find((f) => f.endsWith(`_${slug}.sql`));
  if (!file) throw new Error(`Không thấy migration *_${slug}.sql`);
  return readFileSync(join(MIGRATIONS, file), 'utf8').split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);
};

async function rolledBackOnce(fn: (c: pg.PoolClient) => Promise<void>) {
  const c = await testPool().connect();
  try {
    await c.query('begin');
    // Migration sửa cả bảng trong khi file khác chạy song song khoá đơn rồi ghi. Khoá `exclusive` trước mọi việc: câu đọc
    // thường vẫn chạy, nhưng không ai giữ được khoá dòng của `orders` khi khối này chạy, nên không có vòng chờ (deadlock).
    // Chờ khoá tối đa 500 ms rồi chạy lại cả khối, để file khác không phải xếp hàng lâu sau yêu cầu khoá này.
    await c.query(`set local lock_timeout = '500ms'`);
    await c.query('lock table "order".orders in exclusive mode');
    await fn(c);
  } finally {
    await c.query('rollback');
    c.release();
  }
}

/** Lỗi khoá: hết `lock_timeout` (`55P03`) hay bị chọn huỷ vì deadlock (`40P01`). */
const lockFailure = (err: unknown) => ['55P03', '40P01'].includes((err as { code?: string }).code ?? '');

/** Chạy `fn` trong giao dịch có khoá `exclusive` trên `orders` rồi rollback; không lấy được khoá thì chạy lại cả khối. */
async function rolledBack(fn: (c: pg.PoolClient) => Promise<void>) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await rolledBackOnce(fn);
    } catch (err) {
      if (!lockFailure(err) || attempt >= 20) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}

type Row = {
  status: string;
  cancelling: boolean;
  cancel_pending: boolean;
  cancel_requested: boolean;
  subtotal: string;
  seller_discount: string;
  platform_discount: string;
  total: string;
};

const rowOf = (c: pg.PoolClient) => async (id: string) =>
  (
    await c.query<Row>(
      'select status, cancelling, cancel_pending, cancel_requested, subtotal, seller_discount, platform_discount, total from "order".orders where id = $1',
      [id],
    )
  ).rows[0]!;

async function seed() {
  const { companyId } = await createCompany();
  const { variantId } = await createVariant(companyId);
  return (lines: number) =>
    createOrder(companyId, { lines: Array.from({ length: lines }, () => ({ variantId, quantity: 1, unitPrice: 100000 })), source: 'marketplace' }).then((o) => o.orderId);
}

/** Huỷ món đầu (theo `id`) của đơn. */
const cancelFirstLine = (c: pg.PoolClient, orderId: string) =>
  c.query(
    `update "order".order_lines set cancelled_qty = quantity
     where id = (select id from "order".order_lines where order_id = $1 order by id limit 1)`,
    [orderId],
  );

describe('dọn cờ Đang huỷ kẹt (DH-B03, KH-B09)', () => {
  it('đơn đã dừng bỏ cờ chờ sàn và cờ khách xin huỷ', async () => {
    const order = await seed();
    const cancelledStuck = await order(1);
    const completedRequested = await order(1);
    await rolledBack(async (c) => {
      await c.query(`update "order".orders set status = 'cancelled', cancelling = true where id = $1`, [cancelledStuck]);
      await c.query(`update "order".orders set status = 'completed', outcome = 'full', cancel_requested = true, cancelling = true where id = $1`, [
        completedRequested,
      ]);
      for (const s of statements('dang-huy-du-lieu')) await c.query(s);
      const row = rowOf(c);
      expect(await row(cancelledStuck)).toMatchObject({ status: 'cancelled', cancelling: false });
      expect(await row(completedRequested)).toMatchObject({ status: 'completed', cancelling: false, cancel_requested: false });
    });
  });

  it('sàn đã trả lời (có món đã huỷ, hay sàn đã huỷ khi có kiện bàn giao) thì bỏ cờ; chưa trả lời thì giữ', async () => {
    const order = await seed();
    const partial = await order(2);
    const allCancelled = await order(1);
    const handedOver = await order(1);
    const waiting = await order(1);
    await rolledBack(async (c) => {
      await c.query(`update "order".orders set status = 'processing', cancelling = true where id = any($1::uuid[])`, [[partial, allCancelled, handedOver, waiting]]);
      await cancelFirstLine(c, partial);
      await c.query(`update "order".order_lines set cancelled_qty = quantity where order_id = $1`, [allCancelled]);
      // Sàn huỷ mọi món khi kiện đã rời kho: dòng giữ `cancelled_qty = 0`, đơn mang cờ Sàn đã huỷ (25 §8.2).
      await c.query(`update "order".orders set platform_cancelled = true where id = $1`, [handedOver]);
      for (const s of statements('dang-huy-du-lieu')) await c.query(s);
      const row = rowOf(c);
      expect(await row(partial)).toMatchObject({ cancelling: false });
      expect(await row(allCancelled)).toMatchObject({ cancelling: false });
      expect(await row(handedOver)).toMatchObject({ cancelling: false });
      expect(await row(waiting)).toMatchObject({ status: 'processing', cancelling: true });
    });
  });

  it('tiền đơn còn mở huỷ một phần món tính lại; đơn đã dừng, đơn huỷ hết món giữ nguyên', async () => {
    const order = await seed();
    const partial = await order(2);
    const completedPartial = await order(2);
    const allCancelled = await order(1);
    await rolledBack(async (c) => {
      await c.query(`update "order".orders set status = 'processing', shipping_fee = 15000 where id = any($1::uuid[])`, [[partial, allCancelled]]);
      await c.query(`update "order".orders set status = 'completed', outcome = 'full', shipping_fee = 15000 where id = $1`, [completedPartial]);
      await c.query(`update "order".order_lines set seller_discount = 10000, platform_discount = 5000 where order_id = any($1::uuid[])`, [[partial, completedPartial]]);
      await cancelFirstLine(c, partial);
      await cancelFirstLine(c, completedPartial);
      await c.query(`update "order".order_lines set cancelled_qty = quantity where order_id = $1`, [allCancelled]);
      const row = rowOf(c);
      const completedBefore = await row(completedPartial);
      const allCancelledBefore = await row(allCancelled);

      for (const s of statements('dang-huy-du-lieu')) await c.query(s);

      expect(await row(partial)).toMatchObject({
        subtotal: '100000.00',
        seller_discount: '10000.00',
        platform_discount: '5000.00',
        // 100.000 − 10.000 − 5.000 + phí ship 15.000
        total: '100000.00',
      });
      // Đơn đã dừng có thể đã đối soát với `orders.total` (settlement-match, payment boundary): không sửa.
      expect(await row(completedPartial)).toMatchObject({ subtotal: completedBefore.subtotal, total: completedBefore.total });
      expect(await row(allCancelled)).toMatchObject({ subtotal: allCancelledBefore.subtotal, total: allCancelledBefore.total });
    });
  });
});

describe('chép cờ cũ sang cancel_pending, trigger giữ hai cột bằng nhau', () => {
  it('chép cờ cũ của mọi đơn; chạy lại cũng vậy', async () => {
    const order = await seed();
    const waiting = await order(1);
    const plain = await order(1);
    await rolledBack(async (c) => {
      await c.query(`alter table "order".orders disable trigger orders_sync_cancel_pending`);
      await c.query(`update "order".orders set status = 'processing' where id = any($1::uuid[])`, [[waiting, plain]]);
      await c.query(`update "order".orders set cancelling = true, cancel_pending = false where id = $1`, [waiting]);
      await c.query(`update "order".orders set cancelling = false, cancel_pending = false where id = $1`, [plain]);

      // Chỉ câu dữ liệu: `drop trigger` cần khoá `AccessExclusive` (chặn cả câu đọc của file khác); trigger đã được migration
      // thật tạo lúc dựng DB test, ca dưới kiểm hành vi của nó.
      const data = statements('dang-huy-chuyen-co').filter((s) => !/\b(drop|create) trigger\b/i.test(s));
      for (const s of data) await c.query(s);
      for (const s of data) await c.query(s);

      const row = rowOf(c);
      expect(await row(waiting)).toMatchObject({ cancelling: true, cancel_pending: true });
      expect(await row(plain)).toMatchObject({ cancelling: false, cancel_pending: false });
    });
  });

  it('image cũ ghi cột cũ thì cột mới theo; code mới ghi cột mới thì cột cũ theo (lúc đổi image, lùi image)', async () => {
    const order = await seed();
    const id = await order(1);
    const both = async () =>
      (await testPool().query(`select cancelling, cancel_pending from "order".orders where id = $1`, [id])).rows[0];
    await testPool().query(`update "order".orders set status = 'processing' where id = $1`, [id]);
    await testPool().query(`update "order".orders set cancelling = true where id = $1`, [id]);
    expect(await both()).toEqual({ cancelling: true, cancel_pending: true });
    await testPool().query(`update "order".orders set cancel_pending = false where id = $1`, [id]);
    expect(await both()).toEqual({ cancelling: false, cancel_pending: false });
    // Cập nhật cột khác không đụng cờ.
    await testPool().query(`update "order".orders set cancel_pending = true where id = $1`, [id]);
    await testPool().query(`update "order".orders set attention_note = 'x' where id = $1`, [id]);
    expect(await both()).toEqual({ cancelling: true, cancel_pending: true });
  });
});
