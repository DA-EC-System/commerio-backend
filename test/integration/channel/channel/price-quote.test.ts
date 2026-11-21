// Tính thử giá trước khi đăng và giá gõ lúc đăng (Documents/21 §18.9 R1, 25 §6.2).
// Biến thể có thật trong DB (giá muốn bán, giá vốn đọc qua cổng product thật), cổng sản phẩm của channel giả phần còn lại.
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PriceQuoteList, PushResults } from '#src/modules/channel/channel/api/schemas.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { type ListingVariant, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { stopJobs } from '#src/modules/core/platform/service/jobs/boss.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany, createCustomRole } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { activateShop, fakeAdapter, seedSpecs } from './helpers.ts';

const variants: ListingVariant[] = [];
const port = {
  variants: async (ids?: readonly string[], opts?: { productIds?: readonly string[] }) =>
    variants.filter((v) => (!ids || ids.includes(v.id)) && (!opts?.productIds || opts.productIds.includes(v.productId))),
  standardPrices: async (ids: readonly string[]) => new Map(ids.map((id) => [id, new Decimal(150000)])),
  availableOf: async (ids: readonly string[]) => new Map(ids.map((id) => [id, 7])),
  productImageUrls: async (ids: readonly string[]) => new Map(ids.map((id) => [id, ['https://files.commerio.test/a.jpg']])),
};
setProductPort(port);
registerAdapter(
  'lazada',
  fakeAdapter({ getSeller: async (accessToken) => ({ externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' }) }),
);
afterAll(async () => {
  resetAdapters();
  setProductPort(null);
  await stopJobs();
});

const app = () => request(testApp());
const db = () => testPool();
let company: Awaited<ReturnType<typeof createCompany>>;
let shopId = '';
let noFeeShopId = '';
let noCostToken = '';
const as = (token: string) => (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
/** Phí 14% + 3.000 mỗi món, làm tròn lên bậc 10.000 đuôi 9.000; lãi tối thiểu 10%. Giá muốn bán 200.000 → 239.000, thực nhận 202.540. */
const FEE = { fixedPct: 4, transactionPct: 5, servicePct: 3, optionalPct: 2, returnFee: 0, perItemFee: 3000, roundStep: 10000, roundEnding: 9000 };

async function variant(target: number | null, cost: number) {
  const { variantId, productId, sku } = await createVariant(company.companyId);
  await db().query('update product.product_variants set target_net_price = $2 where id = $1', [variantId, target]);
  await db().query('insert into product.stock_levels (company_id, variant_id, on_hand, avg_cost) values ($1, $2, 2, $3)', [company.companyId, variantId, cost]);
  const v: ListingVariant = {
    id: variantId,
    productId,
    productName: 'Áo thun',
    sku,
    attributesLabel: 'Đen / M',
    productCode: 'SP-TEST',
    groupId: 'GROUP-TEST',
    attributes: [],
    archived: false,
    businessStatus: 'selling',
    description: 'Áo cotton',
    weightG: 250,
    lengthMm: 300,
    widthMm: 200,
    heightMm: 15,
  };
  variants.push(v);
  await seedSpecs(company.companyId, 'lazada', '1', [v]);
  return v;
}
async function connect() {
  const res = await as(company.ceo.token)(app().post('/api/v1/channel/shops/lazada/token')).send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  await activateShop(res.body.shop.id);
  return res.body.shop.id as string;
}
const quote = (productId: string, items: unknown[], token = company.ceo.token) =>
  as(token)(app().post(`/api/v1/channel/products/${productId}/price-quote`)).send({ items });

beforeAll(async () => {
  company = await createCompany({ optionalModules: [] });
  shopId = await connect();
  noFeeShopId = await connect();
  await db().query(
    `insert into finance.config_versions (company_id, kind, shop_id, status, payload, effective_from, created_by, approved_by, approved_at)
     values ($1, 'fee', $2, 'active', $3, '2026-10-01', $4, $5, now()), ($1, 'min_margin', null, 'active', '{"pct":10}', '2026-10-01', $4, $5, now())`,
    [company.companyId, shopId, JSON.stringify(FEE), randomUUID(), randomUUID()],
  );
  noCostToken = (await addMember(company.companyId, await createCustomRole(company.companyId, ['channel.shop.view', 'channel.listing.manage']))).token;
});

describe('POST /channel/products/:productId/price-quote', () => {
  it('giá gõ thử: trả thực nhận, cờ, phiên bản phí; CEO thấy biên lãi; không có giá thấp nhất', async () => {
    const v = await variant(200000, 150000);
    const res = await quote(v.productId, [{ shopId, variantId: v.id, listPrice: 239000 }]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [q] = PriceQuoteList.parse(res.body).items;
    expect(q).toMatchObject({ shopId, variantId: v.id, listPrice: 239000, netReceived: 202540, belowFloor: false, feeWarning: null, blocked: null, marginPct: 25.94 });
    expect(q!.feeConfigId).toEqual(expect.any(String));
    expect(JSON.stringify(res.body)).not.toMatch(/floor"?:\s*\d|"floor"/);
  });

  it('thiếu giá gõ: dùng giá bộ lọc lần đăng sẽ gửi; thực nhận dưới giá thấp nhất bật cờ', async () => {
    const v = await variant(200000, 200000);
    const [q] = (await quote(v.productId, [{ shopId, variantId: v.id }])).body.items;
    expect(q).toMatchObject({ listPrice: 239000, netReceived: 202540, belowFloor: true, blocked: null });
  });

  it('chưa có giá muốn bán và không gõ: price_missing; gian hàng chưa có phí: fee_not_configured, ba số null', async () => {
    const v = await variant(null, 150000);
    const res = await quote(v.productId, [
      { shopId, variantId: v.id },
      { shopId: noFeeShopId, variantId: v.id, listPrice: 239000 },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.items).toMatchObject([
      { shopId, listPrice: null, netReceived: null, belowFloor: null, blocked: { code: 'price_missing' } },
      { shopId: noFeeShopId, listPrice: 239000, netReceived: null, belowFloor: null, feeWarning: null, feeConfigId: null, blocked: { code: 'fee_not_configured' } },
    ]);
  });

  it('người không có inventory.cost.view: không có trường marginPct', async () => {
    const v = await variant(200000, 150000);
    const res = await quote(v.productId, [{ shopId, variantId: v.id, listPrice: 239000 }], noCostToken);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items[0]).not.toHaveProperty('marginPct');
    expect(res.body.items[0]).toMatchObject({ netReceived: 202540 });
  });

  it('SKU của sản phẩm khác: 422 theo dòng; gian hàng không thuộc công ty: 404', async () => {
    const a = await variant(200000, 150000);
    const b = await variant(200000, 150000);
    const bad = await quote(a.productId, [{ shopId, variantId: a.id }, { shopId, variantId: b.id }]);
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toEqual({ 'items.1.variantId': expect.any(String) });
    expect((await quote(a.productId, [{ shopId: randomUUID(), variantId: a.id }])).status).toBe(404);
  });
});

describe('POST /shops/:id/listings/push với listPrices', () => {
  const push = (body: unknown) => as(company.ceo.token)(app().post(`/api/v1/channel/shops/${shopId}/listings/push`)).send(body);

  it('giá gõ thành giá ghi đè tay, không ghi lần tính giá', async () => {
    const v = await variant(200000, 150000);
    const res = await push({ variantIds: [v.id], listPrices: { [v.id]: 259000 } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [r] = PushResults.parse(res.body).results;
    expect(r).toMatchObject({ status: 'pushing', code: null });
    const { rows } = await db().query('select manual_price, price_calc_id from channel.listings where id = $1', [r!.listingId]);
    expect(rows[0]).toEqual({ manual_price: '259000.00', price_calc_id: null });
  });

  it('thực nhận dưới giá thấp nhất: dòng bị chặn below_floor, không tạo listing', async () => {
    const v = await variant(200000, 150000);
    const [r] = (await push({ variantIds: [v.id], listPrices: { [v.id]: 150000 } })).body.results;
    expect(r).toMatchObject({ code: 'below_floor', listingId: null });
    const { rowCount } = await db().query('select 1 from channel.listings where variant_id = $1', [v.id]);
    expect(rowCount).toBe(0);
  });

  it('giá của biến thể ngoài lần đăng: 422 theo khoá', async () => {
    const v = await variant(200000, 150000);
    const other = randomUUID();
    const res = await push({ variantIds: [v.id], listPrices: { [other]: 259000 } });
    expect(res.status).toBe(422);
    expect(res.body.errors).toHaveProperty(`listPrices.${other}`);
  });
});
