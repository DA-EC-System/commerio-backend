// Migration dữ liệu cũ cho huỷ dòng (spec 205 §5.10 "Dữ liệu cũ", D22; AC20). Chạy câu lệnh của file migration trong
// giao dịch rồi rollback, như `allocation-migration.test.ts`.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { createOrder } from '../../helpers/sales.ts';
import { receive } from '../../product/inventory/helpers.ts';
import { channelShop, seedPackage } from './helpers.ts';

const MIGRATIONS = join(import.meta.dirname, '../../../../db/migrations');

/** Các câu lệnh của migration `*_huy-dong-du-lieu.sql`, theo thứ tự trong file. */
const statements = (): string[] => {
  const file = readdirSync(MIGRATIONS).find((f) => f.endsWith('_huy-dong-du-lieu.sql'));
  if (!file) throw new Error('Không thấy migration *_huy-dong-du-lieu.sql');
  return readFileSync(join(MIGRATIONS, file), 'utf8').split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);
};

/** Chạy `fn` trong một giao dịch rồi rollback (trigger kiểm bằng hoãn tới commit nên không chạy). */
async function rolledBack(fn: (c: pg.PoolClient) => Promise<void>) {
  const c = await testPool().connect();
  try {
    await c.query('begin');
    await fn(c);
  } finally {
    await c.query('rollback');
    c.release();
  }
}

describe('dữ liệu cũ cho huỷ dòng (spec 205 §5.10, AC20)', () => {
  it('AC20: dòng đơn chỉ nằm trong kiện đã huỷ được điền cancelled_qty', async () => {
    const { companyId } = await createCompany();
    const { variantId } = await createVariant(companyId);
    await receive(companyId, variantId, 5, 100000);
    const cancelled = await seedPackage(companyId, { status: 'cancelled', lines: [{ variantId, quantity: 2 }] });
    const live = await seedPackage(companyId, { status: 'reserved', lines: [{ variantId, quantity: 1, reserved: true }] });
    const bare = await createOrder(companyId, { lines: [{ variantId, quantity: 1, unitPrice: 100000 }] });
    const [fill] = statements();

    await rolledBack(async (c) => {
      // Dữ liệu trước PR 2: dòng của kiện huỷ chưa có số đã huỷ.
      await c.query('update "order".order_lines set cancelled_qty = 0 where order_id = $1', [cancelled.orderId]);
      await c.query(fill!);
      const qty = async (orderId: string) =>
        (await c.query<{ quantity: number; cancelled_qty: number }>('select quantity, cancelled_qty from "order".order_lines where order_id = $1', [orderId])).rows;
      expect(await qty(cancelled.orderId)).toEqual([{ quantity: 2, cancelled_qty: 2 }]);
      expect(await qty(live.orderId)).toEqual([{ quantity: 1, cancelled_qty: 0 }]);
      expect(await qty(bare.orderId)).toEqual([{ quantity: 1, cancelled_qty: 0 }]);
    });
  });

  it('AC20: đơn còn mở có món huỷ trong dữ liệu gốc được kéo lại, đơn khác giữ nguyên', async () => {
    const { companyId } = await createCompany();
    const { variantId } = await createVariant(companyId);
    const seen = new Date('2026-11-10T00:00:00Z');
    /** Đơn với trạng thái cho trước, một gian hàng riêng đã có mốc kéo, một dòng `raw_orders` với các món đã chuẩn hoá. */
    const rawOrder = async (status: 'processing' | 'cancelled', lineStatuses: string[]) => {
      const shopId = await channelShop(companyId, false);
      await testPool().query('update channel.shops set order_cutoff_at = $2, last_order_sync_at = $2 where id = $1', [shopId, seen]);
      const { orderId } = await createOrder(companyId, { lines: [{ variantId, quantity: 1, unitPrice: 100000 }] });
      await testPool().query('update "order".orders set status = $2 where id = $1', [orderId, status]);
      await testPool().query(
        `insert into channel.raw_orders (company_id, shop_id, order_id, external_order_id, payload, external_update_time)
         values ($1, $2, $3, $4, $5, $6)`,
        [companyId, shopId, orderId, `LZ-${orderId}`, JSON.stringify({ lines: lineStatuses.map((s) => ({ status: s, rawStatus: s })) }), seen],
      );
      return { shopId, orderId };
    };
    const open = await rawOrder('processing', ['pending', 'cancelled']);
    const quiet = await rawOrder('processing', ['pending', 'pending']);
    const closed = await rawOrder('cancelled', ['cancelled']);
    const [, shops, raws] = statements();

    await rolledBack(async (c) => {
      await c.query(shops!);
      await c.query(raws!);
      const state = async (o: { shopId: string; orderId: string }) => ({
        sync: (await c.query('select last_order_sync_at from channel.shops where id = $1', [o.shopId])).rows[0].last_order_sync_at,
        update: (await c.query('select external_update_time from channel.raw_orders where order_id = $1', [o.orderId])).rows[0].external_update_time,
      });
      expect(await state(open)).toEqual({ sync: null, update: null });
      expect(await state(quiet)).toEqual({ sync: seen, update: seen });
      expect(await state(closed)).toEqual({ sync: seen, update: seen });
    });
  });
});
