import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { testPool } from '../../helpers/db.ts';

const db = () => testPool();

async function shop(c: string) {
  const r = await db().query<{ id: string }>(
    "insert into channel.shops (company_id, platform, external_shop_id, shop_name) values ($1, 'lazada', $2, 'Shop Thử') returning id",
    [c, randomUUID()],
  );
  return r.rows[0]!.id;
}

const insertListing = (c: string, shopId: string, cols: Record<string, unknown>) => {
  const all = { company_id: c, shop_id: shopId, ...cols };
  const keys = Object.keys(all);
  return db().query(
    `insert into channel.listings (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(all),
  );
};

// Gian hàng, listing kiêm ghép SKU, lần tính giá (Documents/19 mục 3.3; 25 §6).
describe('ràng buộc gian hàng', () => {
  it('gian hàng hoạt động phải có mốc kéo đơn; một shop của sàn chỉ một bản ghi mỗi công ty', async () => {
    const c = randomUUID();
    const ext = randomUUID();
    const insert = (status: string, cutoff: Date | null) =>
      db().query(
        `insert into channel.shops (company_id, platform, external_shop_id, shop_name, status, order_cutoff_at)
         values ($1, 'lazada', $2, 'Shop', $3, $4)`,
        [c, ext, status, cutoff],
      );
    await expect(insert('active', null)).rejects.toThrow(/"shops_active_cutoff"/);
    await insert('active', new Date());
    await expect(insert('connecting', null)).rejects.toThrow(/shops_company_id_platform_external_shop_id_unique/);
  });
});

describe('ràng buộc listing', () => {
  it('listing chưa đẩy chưa cần mã sàn; mỗi SKU một listing trên một gian hàng', async () => {
    const c = randomUUID();
    const s = await shop(c);
    const v = randomUUID();
    await expect(insertListing(c, s, { variant_id: v })).resolves.toBeDefined();
    await expect(insertListing(c, s, { variant_id: v })).rejects.toThrow(/listings_shop_variant_uq/);
    await expect(insertListing(c, await shop(c), { variant_id: v })).resolves.toBeDefined();
  });

  it('mã SKU sàn không trùng trong một gian hàng; hai gian hàng trùng mã vẫn được', async () => {
    const c = randomUUID();
    const s = await shop(c);
    await insertListing(c, s, { variant_id: randomUUID(), external_sku_id: 'SKU-1' });
    await expect(insertListing(c, s, { variant_id: randomUUID(), external_sku_id: 'SKU-1' })).rejects.toThrow(
      /listings_shop_external_sku_uq/,
    );
    await expect(insertListing(c, await shop(c), { variant_id: randomUUID(), external_sku_id: 'SKU-1' })).resolves.toBeDefined();
  });

  it('ghép "không quản tồn" không có SKU app và phải có người duyệt; ghép thường phải có SKU app', async () => {
    const c = randomUUID();
    const s = await shop(c);
    await expect(insertListing(c, s, { mode: 'unmanaged', external_sku_id: 'COMBO-1' })).rejects.toThrow(
      /"listings_unmanaged_approved"/,
    );
    await expect(
      insertListing(c, s, { mode: 'unmanaged', external_sku_id: 'COMBO-1', approved_by: randomUUID() }),
    ).resolves.toBeDefined();
    await expect(insertListing(c, s, { mode: 'mapped' })).rejects.toThrow(/"listings_mode"/);
  });

  it('sàn từ chối phải kèm lý do', async () => {
    const c = randomUUID();
    await expect(insertListing(c, await shop(c), { variant_id: randomUUID(), status: 'rejected' })).rejects.toThrow(
      /"listings_reject_reason"/,
    );
  });
});

describe('ràng buộc lần tính giá', () => {
  it('giá dưới đáy không xác nhận để đẩy được', async () => {
    const c = randomUUID();
    const s = await shop(c);
    const insert = (status: string, belowFloor: boolean) =>
      db().query(
        `insert into channel.price_calculations (company_id, shop_id, variant_id, cost, target_net, raw_price, rounded_price,
           net_received, margin_pct, below_floor, status, confirmed_by)
         values ($1, $2, $3, 150000, 200000, 236047, 239000, 202540, 35, $4, $5, $6)`,
        [c, s, randomUUID(), belowFloor, status, status === 'pending_confirm' ? null : randomUUID()],
      );
    await expect(insert('pending_confirm', true)).resolves.toBeDefined();
    await expect(insert('confirmed', true)).rejects.toThrow(/"price_calculations_floor"/);
    await expect(insert('confirmed', false)).resolves.toBeDefined();
  });
});
