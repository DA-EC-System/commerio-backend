import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { testPool } from '../../helpers/db.ts';
import { asCompany } from '../../helpers/rls.ts';

const upsertLevel = (c: pg.Pool | pg.PoolClient, companyId: string, variantId: string) =>
  c.query(
    `insert into inventory.stock_levels (company_id, variant_id) values ($1, $2)
     on conflict do nothing`,
    [companyId, variantId],
  );

const insertRule = (c: pg.Pool | pg.PoolClient, companyId: string, variantId: string) =>
  c.query('insert into inventory.reorder_rules (company_id, variant_id, min_qty) values ($1, $2, 5)', [
    companyId,
    variantId,
  ]);

// Khoá tồn và ngưỡng theo công ty (#16 A17): công ty A ghi dòng cho id biến thể của B không được khoá chết biến thể đó.
describe('khoá dòng tồn, ngưỡng tồn theo công ty (#16 A17)', () => {
  it('công ty A đã có dòng tồn cho một id biến thể thì công ty B vẫn tạo và khoá được dòng tồn của mình', async () => {
    const variant = randomUUID();
    await upsertLevel(testPool(), randomUUID(), variant);
    const other = randomUUID();
    const locked = await asCompany(other, async (c) => {
      await upsertLevel(c, other, variant);
      return c.query('select on_hand from inventory.stock_levels where variant_id = $1 for update', [variant]);
    });
    expect(locked.rows).toEqual([{ on_hand: 0 }]);
  });

  it('một công ty chỉ một dòng tồn mỗi biến thể', async () => {
    const company = randomUUID();
    const variant = randomUUID();
    await upsertLevel(testPool(), company, variant);
    await expect(
      testPool().query('insert into inventory.stock_levels (company_id, variant_id) values ($1, $2)', [company, variant]),
    ).rejects.toThrow(/stock_levels_company_id_variant_id_pk/);
  });

  it('ngưỡng tồn: công ty A đã đặt cho một id biến thể thì công ty B vẫn đặt được; trùng trong một công ty bị từ chối', async () => {
    const variant = randomUUID();
    await insertRule(testPool(), randomUUID(), variant);
    const other = randomUUID();
    await expect(asCompany(other, (c) => insertRule(c, other, variant))).resolves.toBeDefined();
    await insertRule(testPool(), other, variant);
    await expect(insertRule(testPool(), other, variant)).rejects.toThrow(/reorder_rules_company_id_variant_id_unique/);
  });

  it('phiếu nhập, phiếu xuất lưu mã đơn tham chiếu (#16 A13)', async () => {
    const company = randomUUID();
    const res = await testPool().query<{ reference: string | null }>(
      `with r as (insert into inventory.stock_receipts (company_id, number, kind, reference)
                  values ($1, $2, 'manual', 'PO-0001') returning reference),
            i as (insert into inventory.stock_issues (company_id, number, kind, order_id, reference)
                  values ($1, $3, 'order', $4, 'DH-0001') returning reference)
       select reference from r union all select reference from i`,
      [company, `PN-${randomUUID().slice(0, 8)}`, `PX-${randomUUID().slice(0, 8)}`, randomUUID()],
    );
    expect(res.rows.map((r) => r.reference).sort()).toEqual(['DH-0001', 'PO-0001']);
  });
});
