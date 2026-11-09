import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { updatePackage } from '#src/modules/order/fulfillment/repository/packages.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createCompany } from '../../helpers/company.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { testPool } from '../../helpers/db.ts';
import { receive } from '../../product/inventory/helpers.ts';
import { seedPackage } from './helpers.ts';

const MIGRATIONS = join(import.meta.dirname, '../../../../db/migrations');

/** Câu `UPDATE` điền `delivery_posted_at` trong migration thêm cột (spec 199c §5.1). */
const deliveryUpdateSql = (): string => {
  const file = readdirSync(MIGRATIONS).find((f) => f.endsWith('_giao-hoan.sql'));
  if (!file) throw new Error('Không thấy migration *_giao-hoan.sql');
  const text = readFileSync(join(MIGRATIONS, file), 'utf8');
  const start = text.indexOf('UPDATE "order"."packages" SET "delivery_posted_at"');
  if (start < 0) throw new Error('Migration không có câu UPDATE điền delivery_posted_at');
  return text.slice(start, text.indexOf(';', start) + 1);
};

const deliveryPostedAtOf = async (packageId: string) =>
  (await testPool().query<{ delivery_posted_at: Date | null }>('select delivery_posted_at from "order".packages where id = $1', [packageId])).rows[0]!
    .delivery_posted_at;

describe('cột delivery_posted_at của kiện (spec 199c §5.1)', () => {
  it('AC17: câu UPDATE của migration điền delivery_posted_at = delivered_at cho kiện đã giao, kiện khác vẫn null', async () => {
    const { companyId } = await createCompany();
    const { variantId } = await createVariant(companyId);
    await receive(companyId, variantId, 5, 100000);
    const delivered = await seedPackage(companyId, { status: 'delivered', lines: [{ variantId, quantity: 1, reserved: true }] });
    const inTransit = await seedPackage(companyId, { status: 'in_transit', lines: [{ variantId, quantity: 1, reserved: true }] });

    const client = await testPool().connect();
    try {
      await client.query('begin');
      // Đặt sẵn delivered_at = 2026-11-10 cho kiện đã giao, cả hai null delivery_posted_at, rồi chạy câu UPDATE.
      await client.query('update "order".packages set delivery_posted_at = null where id in ($1, $2)', [delivered.packageId, inTransit.packageId]);
      await client.query('update "order".packages set delivered_at = $1 where id = $2', [new Date('2026-11-10T08:00:00Z'), delivered.packageId]);
      await client.query(deliveryUpdateSql());
      const { rows } = await client.query<{ id: string; delivery_posted_at: Date | null; delivered_at: Date | null }>(
        'select id, delivery_posted_at, delivered_at from "order".packages where id in ($1, $2)',
        [delivered.packageId, inTransit.packageId],
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get(delivered.packageId)!.delivery_posted_at).toEqual(byId.get(delivered.packageId)!.delivered_at);
      expect(byId.get(inTransit.packageId)!.delivery_posted_at).toBeNull();
    } finally {
      await client.query('rollback');
      client.release();
    }
  });

  it('updatePackage ghi delivery_posted_at của kiện (trong withCompany), kiện mới tạo là null', async () => {
    const { companyId } = await createCompany();
    const { variantId } = await createVariant(companyId);
    await receive(companyId, variantId, 5, 100000);
    const { packageId } = await seedPackage(companyId, { status: 'delivered', lines: [{ variantId, quantity: 1, reserved: true }] });
    expect(await deliveryPostedAtOf(packageId)).toBeNull();

    const at = new Date('2026-11-10T09:30:00Z');
    await withCompany(companyId, () => updatePackage(packageId, { deliveryPostedAt: at }));

    expect(await deliveryPostedAtOf(packageId)).toEqual(at);
  });
});
