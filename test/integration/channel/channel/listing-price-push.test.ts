// Lượt đồng bộ đẩy giá đang bán thay giá chuẩn (#225 phần 2) và nhãn "Giá đã đổi, chưa đẩy" tính lúc đọc (#360; 21 §18.6.6).
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PerSkuResult, PriceQuantity, RemoteSku } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { syncListings } from '#src/modules/channel/channel/service/listing-sync.ts';
import { productPort, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { createModuleContext } from '#src/wiring.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { activateShop, fakeAdapter } from './helpers.ts';

setProductPort(null);
const updatePriceQuantity = vi.fn(async (_t: string, items: readonly PriceQuantity[]) =>
  items.map((i): PerSkuResult => ({ externalSkuId: i.externalSkuId, ok: true })),
);
const getSkus = vi.fn(async (): Promise<RemoteSku[]> => []);
const seller = async (accessToken: string) => ({ externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' });
registerAdapter('lazada', fakeAdapter({ getSeller: seller, getSkus, updatePriceQuantity }));
afterAll(() => resetAdapters());

let company: Awaited<ReturnType<typeof createCompany>>;
let shopId = '';
const db = () => testPool();

/** Listing live đã đồng bộ, giá đẩy lần cuối 100.000, giá chuẩn 100.000 (giữ tồn chờ, không đẩy tồn). */
async function seed(extra: { manualPrice?: number; calc?: number } = {}) {
  const { variantId, sku } = await createVariant(company.companyId);
  await db().query('update product.product_variants set standard_price = 100000 where id = $1', [variantId]);
  let calcId: string | null = null;
  if (extra.calc) {
    const { rows } = await db().query<{ id: string }>(
      `insert into channel.price_calculations (company_id, shop_id, variant_id, target_net, raw_price, rounded_price, net_received,
         fee_pct, tax_pct, trigger, status, confirmed_at, confirmed_by)
       values ($1, $2, $3, 200000, $4, $4, $4, 0, 0, 'target_changed', 'confirmed', now(), $5) returning id`,
      [company.companyId, shopId, variantId, extra.calc, randomUUID()],
    );
    calcId = rows[0]!.id;
  }
  const { rows } = await db().query<{ id: string }>(
    `insert into channel.listings (company_id, shop_id, variant_id, external_product_id, external_sku_id, seller_sku, status,
       stock_sync, price_sync, listed_price, manual_price, price_calc_id)
     values ($1, $2, $3, $4, $5, $6, 'live', 'synced', 'synced', 100000, $7, $8) returning id`,
    [company.companyId, shopId, variantId, `item-${sku}`, `sku-${sku}`, sku, extra.manualPrice ?? null, calcId],
  );
  return { variantId, sku, listingId: rows[0]!.id, calcId };
}
const sync = () => syncListings(productPort(createModuleContext()), company.companyId, shopId);
const pricesSent = (sku: string) =>
  updatePriceQuantity.mock.calls.flatMap(([, items]) => items.filter((i) => i.externalSkuId === `sku-${sku}` && i.price !== undefined).map((i) => i.price));
const listing = async (id: string) => (await db().query('select * from channel.listings where id = $1', [id])).rows[0];
const rowOf = async (variantId: string) =>
  (await request(testApp()).get(`/api/v1/channel/shops/${shopId}/listings`).set('Authorization', `Bearer ${company.ceo.token}`)).body.items.find(
    (i: { variantId: string }) => i.variantId === variantId,
  );

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
  const res = await request(testApp())
    .post('/api/v1/channel/shops/lazada/token')
    .set('Authorization', `Bearer ${company.ceo.token}`)
    .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  shopId = res.body.shop.id;
  await activateShop(shopId);
});
beforeEach(() => vi.clearAllMocks());

describe('lượt đồng bộ đẩy giá đang bán', () => {
  it('giá ghi đè tay 120.000 khác giá đã đẩy → gửi 120.000, listed_price 120.000', async () => {
    const { sku, listingId } = await seed({ manualPrice: 120000 });
    await sync();
    expect(pricesSent(sku)).toEqual(['120000']);
    expect(await listing(listingId)).toMatchObject({ listed_price: '120000.00', price_sync: 'synced' });
  });

  it('giá theo gian hàng đã xác nhận 239.000 → gửi 239.000, lần tính sang pushed', async () => {
    const { sku, calcId } = await seed({ calc: 239000 });
    await sync();
    expect(pricesSent(sku)).toEqual(['239000']);
    expect((await db().query('select status from channel.price_calculations where id = $1', [calcId])).rows[0].status).toBe('pushed');
  });

  it('giá chuẩn bằng giá đã đẩy, không ghi đè, không lần tính → không gửi giá', async () => {
    const { sku } = await seed();
    await sync();
    expect(pricesSent(sku)).toEqual([]);
  });
});

describe('trang listing: "Giá đã đổi, chưa đẩy" tính lúc đọc', () => {
  it('đổi giá chuẩn sau lần đẩy: listing ghi synced trả pending; lượt đồng bộ đẩy xong thì synced', async () => {
    const { variantId, sku } = await seed();
    expect((await rowOf(variantId)).listing.priceSync).toBe('synced');
    await db().query('update product.product_variants set standard_price = 110000 where id = $1', [variantId]);
    expect(await rowOf(variantId)).toMatchObject({ price: 110000, listing: { priceSync: 'pending', lastPushedPrice: 100000 } });
    await sync();
    expect(pricesSent(sku)).toEqual(['110000']);
    expect((await rowOf(variantId)).listing.priceSync).toBe('synced');
  });
});
