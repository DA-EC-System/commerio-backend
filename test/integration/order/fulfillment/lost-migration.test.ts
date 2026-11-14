import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { seedPackage } from './helpers.ts';

const MIGRATIONS = join(import.meta.dirname, '../../../../db/migrations');

const migration = (slug: string): string => {
  const file = readdirSync(MIGRATIONS).find((f) => f.endsWith(`_${slug}.sql`));
  if (!file) throw new Error(`Không thấy migration *_${slug}.sql`);
  return readFileSync(join(MIGRATIONS, file), 'utf8');
};

/** Câu backfill của migration `that-lac-du-lieu` (spec #238 §5.1). */
const backfillSql = (): string => {
  const text = migration('that-lac-du-lieu');
  const start = text.indexOf('update "order".packages set lost_source');
  if (start < 0) throw new Error('Migration that-lac-du-lieu không có câu backfill lost_source');
  return text.slice(start, text.indexOf(';', start) + 1);
};

/** Câu thêm CHECK `packages_lost_confirmed` của migration `that-lac-rang-buoc`. */
const addConfirmedCheckSql = (): string => {
  const text = migration('that-lac-rang-buoc');
  const start = text.indexOf('ALTER TABLE "order"."packages" ADD CONSTRAINT "packages_lost_confirmed"');
  if (start < 0) throw new Error('Migration that-lac-rang-buoc không thêm CHECK packages_lost_confirmed');
  return text.slice(start, text.indexOf(';', start) + 1);
};

describe('migration thất lạc (spec #238 §5.1)', () => {
  it('AC10: câu backfill điền lost_source = marketplace cho kiện lost chưa có người xác nhận, không đụng kiện khác', async () => {
    const { companyId } = await createCompany();
    const { variantId } = await createVariant(companyId);
    const lines = [{ variantId, quantity: 1, unitCost: '100000.00' }];
    const byPlatform = await seedPackage(companyId, { status: 'lost', lines });
    const confirmed = await seedPackage(companyId, { status: 'lost', lines });
    const moving = await seedPackage(companyId, { status: 'in_transit', lines });
    const ids = [byPlatform.packageId, confirmed.packageId, moving.packageId];

    const client = await testPool().connect();
    try {
      await client.query('begin');
      // Dựng dữ liệu như trước migration: cột `lost_source` trống, chưa có CHECK `packages_lost_confirmed`.
      await client.query('alter table "order".packages drop constraint packages_lost_confirmed');
      await client.query('update "order".packages set lost_source = null where id = any($1)', [ids]);
      await client.query('update "order".packages set lost_confirmed_by = $2 where id = $1', [confirmed.packageId, randomUUID()]);

      await client.query(backfillSql());
      const { rows } = await client.query<{ id: string; lost_source: string | null }>(
        'select id, lost_source from "order".packages where id = any($1)',
        [ids],
      );
      const source = new Map(rows.map((r) => [r.id, r.lost_source]));
      expect(source.get(byPlatform.packageId)).toBe('marketplace');
      expect(source.get(confirmed.packageId)).toBeNull();
      expect(source.get(moving.packageId)).toBeNull();

      // Sau backfill, CHECK mới thêm vào không lỗi trên dữ liệu cũ.
      await expect(client.query(addConfirmedCheckSql())).resolves.toBeDefined();
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});
