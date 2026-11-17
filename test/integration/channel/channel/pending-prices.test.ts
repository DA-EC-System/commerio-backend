import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';

// Giá chờ xác nhận, xác nhận, ghi đè tay (#225; Documents/21 §18.6.7, §21.4, 25 §6.2 bước 5–6).
const app = testApp();
const API = '/api/v1/channel';
const db = () => testPool();
const FEE = { fixedPct: 4, transactionPct: 5, servicePct: 3, optionalPct: 2, returnFee: 0, perItemFee: 3000, roundStep: 10000, roundEnding: 9000 };

async function setup() {
  const c = await createCompany({ optionalModules: ['channel'] });
  const { rows } = await db().query<{ id: string }>(
    `insert into channel.shops (company_id, platform, external_shop_id, shop_name, status, order_cutoff_at)
     values ($1, 'lazada', $2, 'Shop Thử', 'active', now()) returning id`,
    [c.companyId, randomUUID()],
  );
  const shopId = rows[0]!.id;
  await db().query(
    `insert into finance.config_versions (company_id, kind, shop_id, status, payload, effective_from, created_by, approved_by, approved_at)
     values ($1, 'fee', $2, 'active', $3, '2026-10-01', $4, $5, now()), ($1, 'min_margin', null, 'active', '{"pct":10}', '2026-10-01', $4, $5, now())`,
    [c.companyId, shopId, JSON.stringify(FEE), randomUUID(), randomUUID()],
  );
  const { variantId } = await createVariant(c.companyId);
  await db().query('update product.product_variants set standard_price = 250000 where id = $1', [variantId]);
  await db().query('insert into product.stock_levels (company_id, variant_id, on_hand, avg_cost) values ($1, $2, 2, 150000)', [c.companyId, variantId]);
  const { rows: l } = await db().query<{ id: string }>(
    `insert into channel.listings (company_id, shop_id, variant_id, status, external_sku_id, price_sync)
     values ($1, $2, $3, 'live', $4, 'synced') returning id`,
    [c.companyId, shopId, variantId, randomUUID()],
  );
  return { ...c, shopId, variantId, listingId: l[0]!.id };
}

async function pending(s: { companyId: string; shopId: string; variantId: string }, price: number, belowFloor: boolean) {
  const { rows } = await db().query<{ id: string }>(
    `insert into channel.price_calculations (company_id, shop_id, variant_id, cost, target_net, raw_price, rounded_price, net_received,
       margin_pct, below_floor, fee_pct, tax_pct, trigger, fee_version_id)
     values ($1, $2, $3, 150000, 200000, $4, $4, $5, 0, $6, 14, 0, 'target_changed', $7) returning id`,
    [s.companyId, s.shopId, s.variantId, price, price * 0.86 - 3000, belowFloor, randomUUID()],
  );
  return rows[0]!.id;
}

const auth = (token: string) => `Bearer ${token}`;
const listingOf = async (id: string) =>
  (await db().query('select version, price_sync, manual_price, price_calc_id from channel.listings where id = $1', [id])).rows[0];

describe('giá chờ xác nhận', () => {
  it('liệt kê bản chờ của gian hàng kèm giá đang bán, không có giá vốn', async () => {
    const s = await setup();
    await pending(s, 239000, false);
    const res = await request(app).get(`${API}/listings/pending-prices`).query({ shopId: s.shopId }).set('Authorization', auth(s.ceo.token));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    expect(res.body.items[0]).toMatchObject({ variantId: s.variantId, price: 250000, pendingPrice: 239000, netReceived: 202540, belowFloor: false });
    expect(JSON.stringify(res.body)).not.toMatch(/150000|165000/);
  });

  it('xác nhận: giá theo gian hàng thành giá đang bán, chờ đẩy lên sàn; đọc lại trên trang listing', async () => {
    const s = await setup();
    const calcId = await pending(s, 239000, false);
    const { version } = await listingOf(s.listingId);
    const res = await request(app).post(`${API}/listings/${s.listingId}/confirm-price`).set('Authorization', auth(s.ceo.token)).send({ version });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await listingOf(s.listingId)).toMatchObject({ price_sync: 'pending', price_calc_id: calcId, manual_price: null });
    const row = (await request(app).get(`${API}/shops/${s.shopId}/listings`).set('Authorization', auth(s.ceo.token))).body.items.find(
      (i: { variantId: string }) => i.variantId === s.variantId,
    );
    expect(row).toMatchObject({ price: 239000, priceSource: 'shop', pendingPrice: null });
  });

  it('bản chờ dưới giá thấp nhất: 422 below_floor; version cũ: 409; không có bản chờ: 409', async () => {
    const s = await setup();
    await pending(s, 189000, true);
    const { version } = await listingOf(s.listingId);
    const post = (v: number) => request(app).post(`${API}/listings/${s.listingId}/confirm-price`).set('Authorization', auth(s.ceo.token)).send({ version: v });
    expect((await post(version + 1)).body.type).toBe('/problems/version_conflict');
    const below = await post(version);
    expect(below.status).toBe(422);
    expect(below.body.type).toBe('/problems/below_floor');
    await db().query("update channel.price_calculations set status = 'superseded' where shop_id = $1", [s.shopId]);
    const none = await post(version);
    expect([none.status, none.body.type]).toEqual([409, '/problems/invalid_transition']);
  });

  it('bản chờ tạo lúc chưa có giá vốn, sau đó có giá vốn làm giá dưới giá thấp nhất: trang giá chờ bật cờ, xác nhận 422 (review P2)', async () => {
    const s = await setup();
    await db().query('delete from product.stock_levels where variant_id = $1', [s.variantId]);
    await db().query(
      `insert into channel.price_calculations (company_id, shop_id, variant_id, cost, target_net, raw_price, rounded_price, net_received,
         margin_pct, below_floor, fee_pct, tax_pct, trigger)
       values ($1, $2, $3, null, 150000, 189000, 189000, 159540, null, null, 14, 0, 'target_changed')`,
      [s.companyId, s.shopId, s.variantId],
    );
    await db().query('insert into product.stock_levels (company_id, variant_id, on_hand, avg_cost) values ($1, $2, 2, 150000)', [s.companyId, s.variantId]);
    const page = await request(app).get(`${API}/listings/pending-prices`).query({ shopId: s.shopId }).set('Authorization', auth(s.ceo.token));
    expect(page.body.items[0]).toMatchObject({ pendingPrice: 189000, belowFloor: true });
    const { version } = await listingOf(s.listingId);
    const res = await request(app).post(`${API}/listings/${s.listingId}/confirm-price`).set('Authorization', auth(s.ceo.token)).send({ version });
    expect([res.status, res.body.type]).toEqual([422, '/problems/below_floor']);
  });

  it('Kho không có quyền quản lý listing: 403', async () => {
    const s = await setup();
    const kho = await addMember(s.companyId, 'warehouse');
    const res = await request(app).get(`${API}/listings/pending-prices`).set('Authorization', auth(kho.token));
    expect(res.status).toBe(403);
  });
});

describe('ghi đè tay', () => {
  const put = (s: { shopId: string; listingId: string; ceo: { token: string } }, body: object) =>
    request(app).put(`${API}/shops/${s.shopId}/listings/${s.listingId}/price`).set('Authorization', auth(s.ceo.token)).send(body);

  it('ghi đè rồi bỏ ghi đè; mỗi lần đánh chờ đẩy giá', async () => {
    const s = await setup();
    let { version } = await listingOf(s.listingId);
    const set = await put(s, { version, price: 229000 });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(await listingOf(s.listingId)).toMatchObject({ manual_price: '229000.00', price_sync: 'pending' });
    ({ version } = await listingOf(s.listingId));
    expect((await put(s, { version, price: null })).status).toBe(200);
    expect(await listingOf(s.listingId)).toMatchObject({ manual_price: null });
  });

  it('giá ghi đè vẫn qua bước 5: 195.000 → thực nhận 164.700 < 165.000 thì 422 below_floor, không đổi gì', async () => {
    const s = await setup();
    const before = await listingOf(s.listingId);
    const res = await put(s, { version: before.version, price: 195000 });
    expect([res.status, res.body.type]).toEqual([422, '/problems/below_floor']);
    expect(await listingOf(s.listingId)).toEqual(before);
  });

  it('giá không phải số nguyên dương: 422 errors.price; listing của gian hàng khác: 404', async () => {
    const s = await setup();
    const { version } = await listingOf(s.listingId);
    const bad = await put(s, { version, price: 1.5 });
    expect(bad.status).toBe(422);
    expect(bad.body.errors.price).toBeDefined();
    const other = await setup();
    const res = await request(app)
      .put(`${API}/shops/${s.shopId}/listings/${other.listingId}/price`)
      .set('Authorization', auth(s.ceo.token))
      .send({ version: 1, price: 229000 });
    expect(res.status).toBe(404);
  });
});
