import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { testPool } from '../../helpers/db.ts';
import { asCompany } from '../../helpers/rls.ts';

const upsertLevel = (c: pg.Pool | pg.PoolClient, companyId: string, variantId: string) =>
  c.query(
    `insert into product.stock_levels (company_id, variant_id) values ($1, $2)
     on conflict do nothing`,
    [companyId, variantId],
  );

// Khoá tồn theo công ty (#16 A17): công ty A ghi dòng cho id biến thể của B không được khoá chết biến thể đó.
describe('khoá dòng tồn theo công ty (#16 A17)', () => {
  it('công ty A đã có dòng tồn cho một id biến thể thì công ty B vẫn tạo và khoá được dòng tồn của mình', async () => {
    const variant = randomUUID();
    await upsertLevel(testPool(), randomUUID(), variant);
    const other = randomUUID();
    const locked = await asCompany(other, async (c) => {
      await upsertLevel(c, other, variant);
      return c.query('select on_hand from product.stock_levels where variant_id = $1 for update', [variant]);
    });
    expect(locked.rows).toEqual([{ on_hand: 0 }]);
  });

  it('một công ty chỉ một dòng tồn mỗi biến thể', async () => {
    const company = randomUUID();
    const variant = randomUUID();
    await upsertLevel(testPool(), company, variant);
    await expect(
      testPool().query('insert into product.stock_levels (company_id, variant_id) values ($1, $2)', [company, variant]),
    ).rejects.toThrow(/stock_levels_company_id_variant_id_pk/);
  });
});
