// Migration điền mốc tên trên sàn cho listing có trước #396 (AC-6): chạy câu SQL của file `*_ten-tren-san-du-lieu.sql` trong
// giao dịch rồi rollback, như `line-cancel-migration.test.ts`.
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';

const MIGRATIONS = join(import.meta.dirname, '../../../../db/migrations');

const statements = (): string[] => {
  const file = readdirSync(MIGRATIONS).find((f) => f.endsWith('_ten-tren-san-du-lieu.sql'));
  if (!file) throw new Error('Không thấy migration *_ten-tren-san-du-lieu.sql');
  return readFileSync(join(MIGRATIONS, file), 'utf8').split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);
};

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

describe('dữ liệu cũ cho cờ "Tên trên sàn đã đổi" (#396, AC-6)', () => {
  it('listing chưa gỡ đang ghép lấy tên trong bản sao làm mốc, tên tiếng Anh để lần đọc sau lấy; dòng khác giữ nguyên', async () => {
    const { companyId } = await createCompany({ optionalModules: ['channel'] });
    const { rows } = await testPool().query<{ id: string }>(
      "insert into channel.shops (company_id, platform, external_shop_id, shop_name) values ($1, 'lazada', $2, 'Shop Thử') returning id",
      [companyId, randomUUID()],
    );
    const shopId = rows[0]!.id;
    const sku = async (title: string) => {
      const id = `sku-${randomUUID().slice(0, 8)}`;
      await testPool().query(
        `insert into channel.remote_skus (company_id, shop_id, external_product_id, external_sku_id, seller_sku, title, title_en, state, quantity)
         values ($1, $2, $3, $4, $5, $6, 'Cup', 'live', 1)`,
        [companyId, shopId, `item-${id}`, id, `LZ-${id}`, title],
      );
      return id;
    };
    const listing = async (status: string, externalSkuId: string | null) =>
      (
        await testPool().query<{ id: string }>(
          `insert into channel.listings (company_id, shop_id, variant_id, external_product_id, external_sku_id, seller_sku, status, reject_reason)
           values ($1, $2, $3, $4, $5, 'LZ', $6, $7) returning id`,
          [companyId, shopId, randomUUID(), externalSkuId && `item-${externalSkuId}`, externalSkuId, status, status === 'rejected' ? 'x' : null],
        )
      ).rows[0]!.id;
    const live = await listing('live', await sku('Cốc đang bán'));
    const failed = await listing('rejected', await sku('Cốc bị từ chối'));
    const gone = await listing('delisted', await sku('Cốc đã gỡ'));
    const absent = await listing('live', `sku-vang-${randomUUID().slice(0, 8)}`);
    const unpushed = await listing('push_failed', null);

    await rolledBack(async (c) => {
      for (const s of statements()) await c.query(s);
      const of = async (id: string) =>
        (
          await c.query(
            'select remote_title_at_match, remote_title_en_at_match, remote_title_matched_at, remote_title_changed_at from channel.listings where id = $1',
            [id],
          )
        ).rows[0];
      const blank = { remote_title_at_match: null, remote_title_en_at_match: null, remote_title_matched_at: null, remote_title_changed_at: null };
      expect(await of(live)).toEqual({ ...blank, remote_title_at_match: 'Cốc đang bán' });
      expect(await of(failed)).toEqual({ ...blank, remote_title_at_match: 'Cốc bị từ chối' });
      expect(await of(gone)).toEqual(blank);
      expect(await of(absent)).toEqual(blank);
      expect(await of(unpushed)).toEqual(blank);
    });
  });
});
