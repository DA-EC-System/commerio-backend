import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lockPackage } from '#src/modules/order/fulfillment/repository/packages.ts';
import { revertHandover, settleHandover } from '#src/modules/order/fulfillment/service/handover-stock.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createCompany } from '../../helpers/company.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { testPool } from '../../helpers/db.ts';
import { receive } from '../../product/inventory/helpers.ts';
import { seedPackage } from './helpers.ts';
import { ingest, remote, setup, withStatus } from './platform-fixtures.ts';

const MIGRATIONS = join(import.meta.dirname, '../../../../db/migrations');

/** Câu `UPDATE` điền `reserved_at` trong migration thêm cột (spec 199b §5.1). */
const backfillSql = (): string => {
  const file = readdirSync(MIGRATIONS).find((f) => f.endsWith('_chia-hang.sql'));
  if (!file) throw new Error('Không thấy migration *_chia-hang.sql');
  const text = readFileSync(join(MIGRATIONS, file), 'utf8');
  const start = text.indexOf('UPDATE "order"."packages"');
  if (start < 0) throw new Error('Migration không có câu UPDATE điền reserved_at');
  return text.slice(start, text.indexOf(';', start) + 1);
};

const reservedAtOf = async (packageId: string) =>
  (await testPool().query<{ reserved_at: Date | null }>('select reserved_at from "order".packages where id = $1', [packageId])).rows[0]!
    .reserved_at;

describe('cột reserved_at của kiện (spec 199b §5.1)', () => {
  it('AC17: câu UPDATE của migration điền reserved_at = created_at cho kiện đang giữ, kiện backordered vẫn null', async () => {
    const { companyId } = await createCompany();
    const { variantId } = await createVariant(companyId);
    await receive(companyId, variantId, 5, 100000);
    const held = await seedPackage(companyId, { status: 'reserved', lines: [{ variantId, quantity: 1, reserved: true }] });
    const waiting = await seedPackage(companyId, { status: 'backordered', lines: [{ variantId, quantity: 1 }] });
    const client = await testPool().connect();
    try {
      await client.query('begin');
      await client.query('update "order".packages set reserved_at = null where id = any($1)', [[held.packageId, waiting.packageId]]);
      await client.query(backfillSql());
      const { rows } = await client.query<{ id: string; reserved_at: Date | null; created_at: Date }>(
        'select id, reserved_at, created_at from "order".packages where id = any($1)',
        [[held.packageId, waiting.packageId]],
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get(held.packageId)!.reserved_at).toEqual(byId.get(held.packageId)!.created_at);
      expect(byId.get(waiting.packageId)!.reserved_at).toBeNull();
    } finally {
      await client.query('rollback');
      client.release();
    }
  });

  it('kiện sàn mới giữ được hàng có reserved_at; sàn huỷ kiện thì reserved_at về null', async () => {
    const s = await setup(10);
    const o = remote(s);
    const { packageId } = await ingest(s.companyId, o);
    expect(await reservedAtOf(packageId)).toBeInstanceOf(Date);

    await ingest(s.companyId, withStatus(o, 'cancelled'));
    expect(await reservedAtOf(packageId)).toBeNull();
  });

  it('huỷ bàn giao kiện đã trừ: dòng giữ lại và kiện có reserved_at', async () => {
    const { companyId } = await createCompany();
    const { variantId } = await createVariant(companyId);
    await receive(companyId, variantId, 5, 100000);
    const { packageId } = await seedPackage(companyId, {
      status: 'in_transit',
      handoverSource: 'scan',
      lines: [{ variantId, quantity: 1, reserved: true }],
    });
    await withCompany(companyId, async () => {
      const pkg = (await lockPackage(packageId))!;
      await settleHandover(pkg, { actorId: null, mode: 'deduct' });
    });
    await testPool().query('update "order".packages set reserved_at = null where id = $1', [packageId]);

    await withCompany(companyId, async () => {
      const pkg = (await lockPackage(packageId))!;
      await revertHandover(pkg, randomUUID(), 'Quét nhầm');
    });
    expect(await reservedAtOf(packageId)).toBeInstanceOf(Date);
  });
});
