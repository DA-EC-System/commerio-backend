import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { testPool } from '../../helpers/db.ts';
import { asCompany } from '../../helpers/rls.ts';

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

  it('hạn trả hàng của gian hàng từ 1 đến 60 ngày, null được (Documents/21 §18.6.2)', async () => {
    const insert = (days: number | null) =>
      db().query(
        "insert into channel.shops (company_id, platform, external_shop_id, shop_name, return_window_days) values ($1, 'lazada', $2, 'Shop', $3)",
        [randomUUID(), randomUUID(), days],
      );
    await expect(insert(0)).rejects.toThrow(/"shops_return_window_days"/);
    await expect(insert(61)).rejects.toThrow(/"shops_return_window_days"/);
    for (const ok of [null, 1, 60]) await insert(ok);
  });

  it('phiếu kiểm kê đầu kỳ: id và số đi cùng nhau, cần mốc, mỗi công ty một gian hàng chờ (#198)', async () => {
    const c = randomUUID();
    const insert = (cols: Record<string, unknown>, company = c) => {
      const all = { company_id: company, platform: 'lazada', external_shop_id: randomUUID(), shop_name: 'Shop', ...cols };
      const keys = Object.keys(all);
      return db().query(
        `insert into channel.shops (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(all),
      );
    };
    const now = new Date();
    await expect(insert({ order_cutoff_at: now, opening_stocktake_id: randomUUID() })).rejects.toThrow(/"shops_opening_stocktake"/);
    await expect(insert({ opening_stocktake_id: randomUUID(), opening_stocktake_number: 'KK-1' })).rejects.toThrow(
      /"shops_opening_stocktake"/,
    );
    // Số SKU chưa ghép tính khi đọc từ bản sao SKU sàn (#220 đợt 2), không còn cột `unmatched_sku_count`.
    await expect(insert({ opening_stock_mode: 'other' })).rejects.toThrow(/"shops_setup_mode"/);
    const waiting = { order_cutoff_at: now, opening_stocktake_id: randomUUID(), opening_stocktake_number: 'KK-1' };
    await insert({ ...waiting, opening_stock_mode: 'stocktake' });
    await expect(insert({ ...waiting, opening_stocktake_id: randomUUID() })).rejects.toThrow(/shops_one_opening_stocktake_uq/);
    await insert({ ...waiting, opening_stocktake_id: randomUUID() }, randomUUID());
    await insert({ order_cutoff_at: now, opening_stock_mode: 'push' });
  });

  it('pg_trgm có sẵn cho gợi ý ghép theo tên (21 §18.7.5)', async () => {
    const r = await db().query<{ s: number }>("select similarity('Áo thun trắng', 'Áo thun trắng size M') as s");
    expect(r.rows[0]!.s).toBeGreaterThan(0.4);
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

  it('dòng đã gỡ không giữ chỗ: đẩy lại SKU, mã SKU sàn tạo dòng mới trỏ dòng cũ (#219, 25 §6.4)', async () => {
    const c = randomUUID();
    const s = await shop(c);
    const v = randomUUID();
    const old = await db().query<{ id: string }>(
      `insert into channel.listings (company_id, shop_id, variant_id, external_sku_id, status, push_error)
       values ($1, $2, $3, 'SKU-9', 'delisted', $4) returning id`,
      [c, s, v, JSON.stringify({ code: 'marketplace_rejected', message: 'Sai danh mục', at: new Date().toISOString() })],
    );
    const oldId = old.rows[0]!.id;
    await insertListing(c, s, { variant_id: v, external_sku_id: 'SKU-9', replaces_listing_id: oldId });
    // Hai dòng chưa gỡ cùng SKU, cùng mã sàn thì vẫn bị chặn.
    await expect(insertListing(c, s, { variant_id: v })).rejects.toThrow(/listings_shop_variant_uq/);
    await expect(insertListing(c, s, { variant_id: randomUUID(), external_sku_id: 'SKU-9' })).rejects.toThrow(
      /listings_shop_external_sku_uq/,
    );
    await expect(insertListing(c, s, { variant_id: randomUUID(), replaces_listing_id: randomUUID() })).rejects.toThrow(
      /listings_replaces_listing_id_listings_id_fk/,
    );
    const { rows } = await db().query<{ code: string }>("select push_error->>'code' as code from channel.listings where id = $1", [oldId]);
    expect(rows[0]!.code).toBe('marketplace_rejected');
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

  it('dòng đã gỡ không giữ ghép chờ duyệt; tự duyệt ghép phải có người duyệt (#220 đợt 2)', async () => {
    const c = randomUUID();
    const s = await shop(c);
    const pending = { pending_variant_id: randomUUID(), pending_mode: 'mapped', pending_requested_by: randomUUID(), pending_requested_at: new Date() };
    await expect(insertListing(c, s, { variant_id: randomUUID(), status: 'delisted', ...pending })).rejects.toThrow(
      /"listings_delisted_no_pending"/,
    );
    await insertListing(c, s, { variant_id: randomUUID(), status: 'live', ...pending });
    await expect(insertListing(c, s, { variant_id: randomUUID(), mapping_self_approved: true })).rejects.toThrow(
      /"listings_self_approved_has_approver"/,
    );
    await insertListing(c, s, { variant_id: randomUUID(), mapping_self_approved: true, approved_by: randomUUID() });
  });

  it('bản sao SKU sàn: một dòng mỗi mã SKU sàn của gian hàng, không giữ SKU đã xoá, tồn không âm (#220 đợt 2)', async () => {
    const c = randomUUID();
    const s = await shop(c);
    const insert = (cols: Record<string, unknown>) => {
      const all = { company_id: c, shop_id: s, external_product_id: 'p1', external_sku_id: 'k1', seller_sku: 'A', title: 'Cốc', state: 'live', quantity: 1, ...cols };
      const keys = Object.keys(all);
      return db().query(
        `insert into channel.remote_skus (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(all),
      );
    };
    await expect(insert({ state: 'deleted' })).rejects.toThrow(/"remote_skus_state"/);
    await expect(insert({ quantity: -1 })).rejects.toThrow(/"remote_skus_quantity"/);
    await insert({});
    await expect(insert({})).rejects.toThrow(/remote_skus_shop_external_sku_uq/);
  });

  it('bản sao SKU sàn cô lập theo công ty: công ty khác không đọc được, không ghi vào được (RLS, #220 đợt 2)', async () => {
    const a = randomUUID();
    const s = await shop(a);
    await db().query(
      `insert into channel.remote_skus (company_id, shop_id, external_product_id, external_sku_id, seller_sku, title, state, quantity)
       values ($1, $2, 'p1', 'k1', 'A', 'Cốc', 'live', 1)`,
      [a, s],
    );
    const count = (c: Parameters<Parameters<typeof asCompany>[1]>[0]) =>
      c.query<{ n: number }>('select count(*)::int as n from channel.remote_skus where shop_id = $1', [s]);
    expect((await asCompany(a, count)).rows[0]!.n).toBe(1);
    const b = randomUUID();
    expect((await asCompany(b, count)).rows[0]!.n).toBe(0);
    await expect(
      asCompany(b, (c) =>
        c.query(
          `insert into channel.remote_skus (company_id, shop_id, external_product_id, external_sku_id, seller_sku, title, state, quantity)
           values ($1, $2, 'p2', 'k2', 'B', 'Cốc', 'live', 1)`,
          [a, s],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
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
