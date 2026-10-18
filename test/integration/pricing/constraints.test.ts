import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { testPool } from '../helpers/db.ts';

async function insertPricelist(companyId: string, type: 'standard' | 'channel', shopId: string | null = null) {
  const res = await testPool().query<{ id: string }>(
    'insert into pricing.pricelists (company_id, name, type, shop_id) values ($1, $2, $3, $4) returning id',
    [companyId, `Bảng giá ${type}`, type, shopId],
  );
  return res.rows[0]!.id;
}

const insertItem = (companyId: string, pricelistId: string, variantId: string, price: string) =>
  testPool().query(
    'insert into pricing.pricelist_items (company_id, pricelist_id, variant_id, price) values ($1, $2, $3, $4)',
    [companyId, pricelistId, variantId, price],
  );

// Ràng buộc của pricing (plan chuẩn bị 4.2, 4.3; Documents/21 G2, G3; 19-D33; AC-9).
describe('ràng buộc bảng pricing (AC-9)', () => {
  it('mỗi công ty đúng một bảng giá chuẩn', async () => {
    const company = randomUUID();
    await insertPricelist(company, 'standard');
    await expect(insertPricelist(company, 'standard')).rejects.toThrow(/pricelists_one_standard_per_company/);
    await expect(insertPricelist(randomUUID(), 'standard')).resolves.toBeDefined();
  });

  it('bảng theo gian hàng phải có shop_id, bảng chuẩn thì không', async () => {
    const company = randomUUID();
    await expect(insertPricelist(company, 'channel', null)).rejects.toThrow(/check constraint/);
    await expect(insertPricelist(company, 'standard', randomUUID())).rejects.toThrow(/check constraint/);
  });

  it('mỗi gian hàng tối đa một bảng giá', async () => {
    const company = randomUUID();
    const shop = randomUUID();
    await insertPricelist(company, 'channel', shop);
    await expect(insertPricelist(company, 'channel', shop)).rejects.toThrow(/duplicate key/);
  });

  it('một biến thể chỉ có một giá trong một bảng giá, giá không âm', async () => {
    const company = randomUUID();
    const pricelist = await insertPricelist(company, 'standard');
    const variant = randomUUID();
    await insertItem(company, pricelist, variant, '150000');
    await expect(insertItem(company, pricelist, variant, '160000')).rejects.toThrow(/duplicate key/);
    await expect(insertItem(company, pricelist, randomUUID(), '-1')).rejects.toThrow(/check constraint/);
  });

  it('giá lưu numeric(18,2), đọc ra là chuỗi đủ hai số lẻ', async () => {
    const company = randomUUID();
    const pricelist = await insertPricelist(company, 'standard');
    const variant = randomUUID();
    await insertItem(company, pricelist, variant, '199000');
    const res = await testPool().query('select price from pricing.pricelist_items where variant_id = $1', [variant]);
    expect(res.rows[0]).toEqual({ price: '199000.00' });
  });
});
