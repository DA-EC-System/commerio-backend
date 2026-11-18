// Hạn bàn giao của kiện theo đơn (KH-B01): trigger `packages_ship_by_order` và phần điền dữ liệu của migration
// `*_han-ban-giao-kien`.
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { receive } from '../../product/inventory/helpers.ts';
import { channelShop, seedPackage } from './helpers.ts';

const MIGRATIONS = join(import.meta.dirname, '../../../../db/migrations');

/** Các câu chỉ đổi dữ liệu của migration (trước `CREATE FUNCTION`). */
const backfillStatements = (): string[] => {
  const file = readdirSync(MIGRATIONS).find((f) => f.endsWith('_han-ban-giao-kien.sql'));
  if (!file) throw new Error('Không thấy migration *_han-ban-giao-kien.sql');
  const text = readFileSync(join(MIGRATIONS, file), 'utf8');
  const data = text.slice(0, text.indexOf('CREATE FUNCTION'));
  return data
    .split('--> statement-breakpoint')
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter((s) => s.startsWith('UPDATE'));
};

const D1 = new Date('2026-11-20T10:00:00Z');
const D2 = new Date('2026-11-21T10:00:00Z');
let companyId: string;
let variantId: string;

beforeAll(async () => {
  ({ companyId } = await createCompany());
  ({ variantId } = await createVariant(companyId));
  await receive(companyId, variantId, 100, 100000);
});

const line = () => [{ variantId, quantity: 1 }];

describe('trigger packages_ship_by_order (KH-B01)', () => {
  it('kiện đơn sàn chưa bàn giao đổi hạn khác đơn: bị chặn lúc commit', async () => {
    const p = await seedPackage(companyId, { status: 'reserved', shipBy: D1, lines: line() });
    await expect(testPool().query('update "order".packages set ship_by = $2 where id = $1', [p.packageId, D2])).rejects.toMatchObject({
      code: '23514',
      constraint: 'packages_ship_by_order',
    });
  });

  it('đơn đổi hạn mà kiện chưa bàn giao không đổi theo: bị chặn; đổi cả hai trong một giao dịch thì qua', async () => {
    const p = await seedPackage(companyId, { status: 'packed', shipBy: D1, lines: line() });
    await expect(testPool().query('update "order".orders set ship_by = $2 where id = $1', [p.orderId, D2])).rejects.toMatchObject({
      code: '23514',
      constraint: 'packages_ship_by_order',
    });
    const client = await testPool().connect();
    try {
      await client.query('begin');
      await client.query('update "order".orders set ship_by = $2 where id = $1', [p.orderId, D2]);
      await client.query('update "order".packages set ship_by = $2 where id = $1', [p.packageId, D2]);
      await client.query('commit');
    } finally {
      client.release();
    }
  });

  it('kiện quay về chờ lấy hàng mà mang hạn cũ: bị chặn', async () => {
    const p = await seedPackage(companyId, { status: 'in_transit', shipBy: D1, lines: line() });
    // Kiện đã rời kho được giữ hạn cũ khi đơn đổi hạn.
    await testPool().query('update "order".orders set ship_by = $2 where id = $1', [p.orderId, D2]);
    await expect(
      testPool().query(
        `update "order".packages set status = 'awaiting_pickup', handed_over_at = null, handover_source = null where id = $1`,
        [p.packageId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'packages_ship_by_order' });
  });

  it('đơn tay không bị ràng buộc', async () => {
    const p = await seedPackage(companyId, { status: 'reserved', manual: true, lines: line() });
    await testPool().query('update "order".packages set ship_by = $2 where id = $1', [p.packageId, D2]);
  });
});

describe('điền dữ liệu của migration *_han-ban-giao-kien', () => {
  it('lấy lại hạn đơn bị xoá, kiện chưa bàn giao nhận hạn đơn, kiện đã rời kho chỉ điền khi trống, đơn còn thiếu hạn được kéo lại', async () => {
    const shopId = await channelShop(companyId, false);
    const wiped = await seedPackage(companyId, { status: 'reserved', shipBy: D1, lines: line() });
    const waiting = await seedPackage(companyId, { status: 'backordered', shipBy: D2, lines: line() });
    const goneEmpty = await seedPackage(companyId, { status: 'in_transit', shipBy: D2, lines: line() });
    const goneKept = await seedPackage(companyId, { status: 'delivered', shipBy: D2, lines: line() });
    const missing = await seedPackage(companyId, { status: 'reserved', shipBy: null, shopId, lines: line() });
    const externalOrderId = `LZ-${randomUUID().slice(0, 8)}`;
    await testPool().query('update channel.shops set last_order_sync_at = now() where id = $1', [shopId]);
    await testPool().query(
      `insert into channel.raw_orders (company_id, shop_id, order_id, external_order_id, payload, external_update_time)
       values ($1, $2, $3, $4, '{}'::jsonb, now())`,
      [companyId, shopId, missing.orderId, externalOrderId],
    );

    const client = await testPool().connect();
    const pkg = async (id: string) =>
      (await client.query<{ ship_by: Date | null; version: number }>('select ship_by, version from "order".packages where id = $1', [id])).rows[0]!;
    try {
      await client.query('begin');
      // Dữ liệu cũ trước KH-B01 (giao dịch này rollback, trigger hoãn tới commit nên không chặn).
      await client.query('update "order".orders set ship_by = null where id = $1', [wiped.orderId]);
      await client.query('update "order".packages set ship_by = null where id = $1', [waiting.packageId]);
      await client.query('update "order".packages set ship_by = null where id = $1', [goneEmpty.packageId]);
      await client.query('update "order".packages set ship_by = $2 where id = $1', [goneKept.packageId, D1]);
      const waitingVersion = (await pkg(waiting.packageId)).version;

      for (const statement of backfillStatements()) await client.query(statement);

      const orderShipBy = async (id: string) =>
        (await client.query<{ ship_by: Date | null }>('select ship_by from "order".orders where id = $1', [id])).rows[0]!.ship_by;
      expect(await orderShipBy(wiped.orderId)).toEqual(D1);
      expect(await pkg(waiting.packageId)).toEqual({ ship_by: D2, version: waitingVersion + 1 });
      expect((await pkg(goneEmpty.packageId)).ship_by).toEqual(D2);
      expect((await pkg(goneKept.packageId)).ship_by).toEqual(D1);
      const { rows } = await client.query<{ at: Date | null; synced: Date | null }>(
        `select r.external_update_time as at, s.last_order_sync_at as synced
           from channel.raw_orders r join channel.shops s on s.id = r.shop_id where r.order_id = $1`,
        [missing.orderId],
      );
      expect(rows).toEqual([{ at: new Date(0), synced: null }]);
      // Sau điền dữ liệu, mọi kiện đều thoả ràng buộc.
      await client.query('set constraints "order".packages_ship_by_order immediate');
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});
