// Lần đẩy đầu dùng giá bộ lọc của gian hàng, chặn `below_floor` (#225 phần 2; Documents/21 §18.5, §18.6.4, 25 §6.2).
// Biến thể có thật trong DB (giá muốn bán, giá vốn đọc qua cổng product thật), cổng sản phẩm của channel giả phần còn lại.
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PushResults } from '#src/modules/channel/channel/api/schemas.ts';
import { runListingPush } from '#src/modules/channel/channel/service/listing-push.ts';
import type { NewProduct } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { type ListingVariant, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { stopJobs } from '#src/modules/core/platform/service/jobs/boss.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { activateShop, fakeAdapter } from './helpers.ts';

const categoryId = randomUUID();
const variants: ListingVariant[] = [];
const port = {
  variants: async (ids?: readonly string[]) => variants.filter((v) => !ids || ids.includes(v.id)),
  standardPrices: async (ids: readonly string[]) => new Map(ids.map((id) => [id, new Decimal(150000)])),
  availableOf: async (ids: readonly string[]) => new Map(ids.map((id) => [id, 7])),
  productImageUrls: async (ids: readonly string[]) => new Map(ids.map((id) => [id, ['https://files.commerio.test/a.jpg']])),
};
setProductPort(port);
const createProduct = vi.fn(async (_t: string, p: NewProduct) => ({ externalProductId: `item-${p.sellerSku}`, externalSkuId: `sku-${p.sellerSku}`, live: false }));
registerAdapter(
  'lazada',
  fakeAdapter({
    getSeller: async (accessToken) => ({ externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' }),
    categoryAttributes: async () => [],
    uploadImage: async (_t, url) => url,
    createProduct,
  }),
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
const auth = (r: request.Test) => r.set('Authorization', `Bearer ${company.ceo.token}`);
/** Phí 14% + 3.000 mỗi món, làm tròn lên bậc 10.000 đuôi 9.000; lãi tối thiểu 10%. Giá muốn bán 200.000 → 239.000, thực nhận 202.540. */
const FEE = { fixedPct: 4, transactionPct: 5, servicePct: 3, optionalPct: 2, returnFee: 0, perItemFee: 3000, roundStep: 10000, roundEnding: 9000 };

/** Biến thể thật kèm giá muốn bán, giá vốn; đưa vào cổng giả với cùng id. */
async function variant(target: number | null, cost: number) {
  const { variantId, productId, sku } = await createVariant(company.companyId);
  await db().query('update product.product_variants set target_net_price = $2 where id = $1', [variantId, target]);
  await db().query('insert into product.stock_levels (company_id, variant_id, on_hand, avg_cost) values ($1, $2, 2, $3)', [company.companyId, variantId, cost]);
  variants.push({
    id: variantId,
    productId,
    productName: 'Áo thun',
    sku,
    categoryId,
    attributesLabel: 'Đen / M',
    archived: false,
    businessStatus: 'selling',
    description: 'Áo cotton',
    weightG: 250,
    lengthMm: 300,
    widthMm: 200,
    heightMm: 15,
  });
  return variantId;
}
async function push(variantId: string) {
  const res = await auth(app().post(`/api/v1/channel/shops/${shopId}/listings/push`)).send({ variantIds: [variantId] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return PushResults.parse(res.body).results[0]!;
}
const calcOf = async (listingId: string) =>
  (
    await db().query(
      'select c.status, c.trigger, c.rounded_price, c.confirmed_by from channel.listings l join channel.price_calculations c on c.id = l.price_calc_id where l.id = $1',
      [listingId],
    )
  ).rows[0];

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
  const res = await auth(app().post('/api/v1/channel/shops/lazada/token')).send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  shopId = res.body.shop.id;
  await activateShop(shopId);
  expect((await auth(app().put(`/api/v1/channel/shops/${shopId}/category-maps/${categoryId}`)).send({ externalCategoryId: '1', attributes: {}, version: null })).status).toBe(200);
  await db().query(
    `insert into finance.config_versions (company_id, kind, shop_id, status, payload, effective_from, created_by, approved_by, approved_at)
     values ($1, 'fee', $2, 'active', $3, '2026-10-01', $4, $5, now()), ($1, 'min_margin', null, 'active', '{"pct":10}', '2026-10-01', $4, $5, now())`,
    [company.companyId, shopId, JSON.stringify(FEE), randomUUID(), randomUUID()],
  );
});
beforeEach(() => {
  createProduct.mockClear();
});

describe('đẩy lần đầu theo giá bộ lọc', () => {
  it('có giá muốn bán: ghi lần tính push đã xác nhận 239.000 (người bấm), việc nền gửi 239.000 rồi lần tính sang pushed', async () => {
    const variantId = await variant(200000, 150000);
    const r = await push(variantId);
    expect(r).toMatchObject({ status: 'pushing', code: null });
    expect(await calcOf(r.listingId!)).toMatchObject({ status: 'confirmed', trigger: 'push', rounded_price: '239000.00' });
    await runListingPush(port, {
      companyId: company.companyId,
      shopId,
      listingId: r.listingId!,
      imageUrls: ['https://files.commerio.test/a.jpg'],
    });
    expect(createProduct.mock.calls[0]![1].price).toBe('239000');
    expect(await calcOf(r.listingId!)).toMatchObject({ status: 'pushed' });
    expect((await db().query('select listed_price from channel.listings where id = $1', [r.listingId])).rows[0].listed_price).toBe('239000.00');
  });

  it('thực nhận dưới giá thấp nhất (giá vốn 200.000 → giá thấp nhất 220.000) → chặn below_floor, không tạo listing', async () => {
    const variantId = await variant(200000, 200000);
    expect(await push(variantId)).toMatchObject({ code: 'below_floor', listingId: null, status: null });
  });

  it('không có giá muốn bán: đẩy giá chuẩn, không ghi lần tính', async () => {
    const variantId = await variant(null, 150000);
    const r = await push(variantId);
    expect(r).toMatchObject({ status: 'pushing', code: null });
    expect(await calcOf(r.listingId!)).toBeUndefined();
  });
});
