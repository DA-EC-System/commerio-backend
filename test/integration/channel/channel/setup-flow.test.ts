// Thiết lập theo #198 (Documents/21 §18.6.2, §18.7.5–18.7.7): mốc do BE đặt, gian hàng đầu tiên buộc kiểm kê đầu kỳ,
// chờ kiểm kê, lượt kéo đơn còn mở, quyết định từng SKU, tiến độ thiết lập. Mỗi ca một công ty riêng.
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { ShopSetupPreview, ShopSetupResult } from '#src/modules/channel/channel/api/schemas.ts';
import { setStocktakePort } from '#src/modules/channel/channel/service/stocktake-port.ts';
import { AppError } from '#src/shared/errors/app-error.ts';
import type { RemoteSku } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { type ListingVariant, productPort, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { syncListings } from '#src/modules/channel/channel/service/listing-sync.ts';
import { createModuleContext } from '#src/wiring.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { setModuleEnabled } from '../../helpers/state.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { fakeAdapter } from './helpers.ts';

const variant = (sku: string, productName = 'Áo', attributesLabel = ''): ListingVariant => ({
  id: randomUUID(),
  productId: randomUUID(),
  productName,
  sku,
  categoryId: randomUUID(),
  attributesLabel,
  archived: false,
  businessStatus: 'selling',
  description: null,
  weightG: 200,
  lengthMm: 100,
  widthMm: 100,
  heightMm: 10,
});
const bySku = variant('CMR-1', 'Áo thun', 'Trắng');
const variants = [bySku];

setProductPort({
  variants: async (ids) => variants.filter((v) => !ids || ids.includes(v.id)),
  standardPrices: async (ids) => new Map(ids.map((id) => [id, new Decimal(50000)])),
  productImageUrls: async () => new Map<string, string[]>(),
  availableOf: async (ids) => new Map(ids.map((id) => [id, 9])),
});

const remote: RemoteSku[] = [
  { externalProductId: 'item-1', externalSkuId: 'sku-1', sellerSku: 'CMR-1', title: 'Áo thun trắng', state: 'live', rejectReason: null, quantity: 4 },
];
const updatePriceQuantity = vi.fn(async (_t: string, items: readonly { externalSkuId: string }[]) =>
  items.map((i) => ({ externalSkuId: i.externalSkuId, ok: true as const })),
);
registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
    },
    getSkus: async (_t, sellerSkus) => remote.filter((r) => sellerSkus.includes(r.sellerSku)),
    updatePriceQuantity,
  }),
);
afterAll(() => {
  resetAdapters();
  setProductPort(null);
});
afterEach(() => updatePriceQuantity.mockClear());

const app = () => request(testApp());
type Company = Awaited<ReturnType<typeof createCompany>>;

async function connectingShop(company: Company): Promise<string> {
  const res = await app()
    .post('/api/v1/channel/shops/lazada/token')
    .set('Authorization', `Bearer ${company.ceo.token}`)
    .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  expect(res.status).toBe(201);
  return res.body.shop.id as string;
}

/** Gian hàng khác của công ty, dựng thẳng bằng SQL ở trạng thái cần (chủ bảng, bỏ qua RLS). */
async function otherShop(companyId: string, cols: Record<string, unknown>): Promise<void> {
  const all = { company_id: companyId, platform: 'lazada', external_shop_id: randomUUID(), shop_name: 'Shop khác', ...cols };
  const keys = Object.keys(all);
  await testPool().query(
    `insert into channel.shops (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(all),
  );
}
const setUp = { status: 'active', order_cutoff_at: new Date('2026-10-01T00:00:00Z') };
const waiting = { ...setUp, opening_stocktake_id: randomUUID(), opening_stocktake_number: 'KK-000001' };

const preview = (c: Company, shopId: string) =>
  app().get(`/api/v1/channel/shops/${shopId}/setup`).set('Authorization', `Bearer ${c.ceo.token}`);
const setup = (c: Company, shopId: string, body: object) =>
  app().post(`/api/v1/channel/shops/${shopId}/setup`).set('Authorization', `Bearer ${c.ceo.token}`).send(body);

async function shopRow(id: string) {
  const { rows } = await testPool().query('select status, order_cutoff_at from channel.shops where id = $1', [id]);
  const listings = await testPool().query('select count(*)::int as n from channel.listings where shop_id = $1', [id]);
  return { ...rows[0], listings: listings.rows[0].n as number };
}

describe('mốc kéo đơn và gian hàng đầu tiên (AC-1, AC-2, AC-4, AC-5, AC-18)', () => {
  it('AC-2, AC-5: GET /setup trả proposedCutoffAt lúc gọi; công ty chưa có gian hàng xong thiết lập là gian hàng đầu tiên', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const shopId = await connectingShop(c);
    const t0 = Date.now();
    const res = await preview(c, shopId);
    const t1 = Date.now();
    expect(res.status).toBe(200);
    const body = ShopSetupPreview.parse(res.body);
    const proposed = new Date(body.proposedCutoffAt).getTime();
    expect(proposed).toBeGreaterThanOrEqual(t0 - 1000);
    expect(proposed).toBeLessThanOrEqual(t1);
    expect(body.firstShopOfCompany).toBe(true);
  });

  it.each([
    ['gian hàng active thiết lập bằng push', setUp, false],
    ['gian hàng đã ngắt, từng thiết lập', { ...setUp, status: 'disconnected', disconnected_at: new Date() }, false],
    ['chỉ gian hàng đang chờ kiểm kê', waiting, true],
    ['chỉ gian hàng khác đang thiết lập', {}, true],
  ])('AC-5: %s → firstShopOfCompany theo cột thứ ba', async (_name, cols, expected) => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const shopId = await connectingShop(c);
    await otherShop(c.companyId, cols);
    const res = await preview(c, shopId);
    expect(res.body.firstShopOfCompany).toBe(expected);
  });

  it('AC-5: gian hàng xong thiết lập của công ty khác không làm công ty này thành "không phải đầu tiên"', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const shopId = await connectingShop(c);
    await otherShop(randomUUID(), setUp);
    expect((await preview(c, shopId)).body.firstShopOfCompany).toBe(true);
  });

  it('AC-4: gian hàng đầu tiên gửi push → 422 errors.openingStock; đọc lại vẫn connecting, không listing', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const shopId = await connectingShop(c);
    const res = await setup(c, shopId, { externalSkuIds: ['sku-1'], openingStock: 'push' });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual({ openingStock: 'Gian hàng đầu tiên của công ty phải kiểm kê đầu kỳ' });
    expect(await shopRow(shopId)).toMatchObject({ status: 'connecting', order_cutoff_at: null, listings: 0 });
  });

  it('AC-1: orderCutoffAt trong body bị bỏ qua (kể cả tương lai, sai định dạng); mốc = lúc gọi POST', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const shopId = await connectingShop(c);
    await otherShop(c.companyId, setUp);
    const t0 = Date.now();
    const res = await setup(c, shopId, { externalSkuIds: ['sku-1'], openingStock: 'push', orderCutoffAt: 'không phải ngày' });
    const t1 = Date.now();
    expect(res.status).toBe(200);
    const cutoff = new Date(res.body.shop.orderCutoffAt).getTime();
    expect(cutoff).toBeGreaterThanOrEqual(t0 - 1000);
    expect(cutoff).toBeLessThanOrEqual(t1);
    const read = await app().get(`/api/v1/channel/shops/${shopId}`).set('Authorization', `Bearer ${c.ceo.token}`);
    expect(read.body.orderCutoffAt).toBe(res.body.shop.orderCutoffAt);
    expect((await setup(c, await connectingShop(c), { openingStock: 'push', orderCutoffAt: '2099-01-01T00:00:00Z' })).status).toBe(200);
  });

  it.each(['push', 'stocktake'])('AC-18: công ty đang chờ phiếu đầu kỳ → %s 422 errors.openingStock, vẫn connecting', async (mode) => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const shopId = await connectingShop(c);
    await otherShop(c.companyId, waiting);
    const res = await setup(c, shopId, { externalSkuIds: ['sku-1'], openingStock: mode });
    expect(res.status).toBe(422);
    expect(res.body.errors.openingStock).toBe('Công ty đang chờ phiếu kiểm kê đầu kỳ KK-000001 ghi sổ');
    expect(await shopRow(shopId)).toMatchObject({ status: 'connecting', listings: 0 });
  });
});

describe('kiểm kê đầu kỳ và chế độ chờ (AC-6, AC-7, AC-8, AC-9, AC-16, AC-18)', () => {
  afterEach(() => setStocktakePort());

  function fakeStocktake() {
    const create = vi.fn(async (_shopId: string, _o: { actorId: string }) => ({ documentId: randomUUID(), number: `KK-${randomUUID().slice(0, 6)}`, created: true }));
    setStocktakePort({ createOpeningStocktake: create, openingStocktakeStatusOf: async (ids) => new Map(ids.map((id) => [id, 'pending'])) });
    return create;
  }

  it('AC-7: cổng mặc định lập phiếu kiểm kê đầu kỳ thật của inventory (#245), gian hàng chờ kiểm kê phiếu nháp', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const shopId = await connectingShop(c);
    const res = await setup(c, shopId, { externalSkuIds: ['sku-1'], openingStock: 'stocktake' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const result = ShopSetupResult.parse(res.body);
    expect(result.stocktakeNumber).toMatch(/^KK-/);
    expect(result.shop).toMatchObject({ status: 'active', openingStocktake: { number: result.stocktakeNumber, status: 'draft' } });
  });

  it('AC-7: lập phiếu lỗi thì rollback, đọc lại vẫn connecting, không listing', async () => {
    setStocktakePort({
      createOpeningStocktake: () => Promise.reject(new AppError(503, 'service_unavailable', 'Kho đang bận')),
      openingStocktakeStatusOf: async () => new Map(),
    });
    const c = await createCompany({ optionalModules: ['channel'] });
    const shopId = await connectingShop(c);
    const res = await setup(c, shopId, { externalSkuIds: ['sku-1'], openingStock: 'stocktake' });
    expect(res.status).toBe(503);
    expect(await shopRow(shopId)).toMatchObject({ status: 'connecting', order_cutoff_at: null, listings: 0 });
  });

  it('AC-6, AC-9: stocktake lập phiếu một lần, gian hàng active chờ kiểm kê; lúc thiết lập chỉ đẩy giá', async () => {
    const create = fakeStocktake();
    const c = await createCompany({ optionalModules: ['channel'] });
    const shopId = await connectingShop(c);
    const t0 = Date.now();
    const res = await setup(c, shopId, { externalSkuIds: ['sku-1'], openingStock: 'stocktake' });
    expect(res.status).toBe(200);
    const result = ShopSetupResult.parse(res.body);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toBe(shopId);
    const doc = await create.mock.results[0]!.value;
    expect(result.stocktakeNumber).toBe(doc.number);
    expect(result.shop).toMatchObject({ status: 'active', openingStocktake: { documentId: doc.documentId, number: doc.number, status: 'pending' } });
    expect(new Date(result.shop.orderCutoffAt!).getTime()).toBeGreaterThanOrEqual(t0 - 1000);
    expect(updatePriceQuantity).toHaveBeenCalledWith(expect.any(String), [{ externalProductId: 'item-1', externalSkuId: 'sku-1', price: '50000' }]);
    const { rows } = await testPool().query('select stock_sync, stock_sync_error, price_sync from channel.listings where shop_id = $1', [shopId]);
    expect(rows).toEqual([{ stock_sync: 'pending', stock_sync_error: null, price_sync: 'synced' }]);
    const list = await app().get('/api/v1/channel/shops').set('Authorization', `Bearer ${c.ceo.token}`);
    expect(list.body.items.find((s: { id: string }) => s.id === shopId).openingStocktake.number).toBe(doc.number);
    const one = await app().get(`/api/v1/channel/shops/${shopId}`).set('Authorization', `Bearer ${c.ceo.token}`);
    expect(one.body.openingStocktake.documentId).toBe(doc.documentId);

    // Lượt đồng bộ sau (giá đã synced, tồn còn pending) không gọi sàn khi còn chờ.
    updatePriceQuantity.mockClear();
    const sync = await syncListings(productPort(createModuleContext()), c.companyId, shopId);
    expect(sync.errors).toBe(0);
    expect(updatePriceQuantity).not.toHaveBeenCalled();

    // AC-8: chờ kiểm kê thì đẩy listing 409, không ghi listing.
    const push = await app()
      .post(`/api/v1/channel/shops/${shopId}/listings/push`)
      .set('Authorization', `Bearer ${c.ceo.token}`)
      .send({ variantIds: [randomUUID()] });
    expect(push.status).toBe(409);
    expect(push.body.code).toBe('shop_awaiting_stocktake');
    expect((await shopRow(shopId)).listings).toBe(1);
  });

  it('AC-16 (phần thiết lập): push chỉ đẩy giá, tồn chờ lượt kéo đơn còn mở', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const shopId = await connectingShop(c);
    await otherShop(c.companyId, setUp);
    expect((await setup(c, shopId, { externalSkuIds: ['sku-1'], openingStock: 'push' })).status).toBe(200);
    expect(updatePriceQuantity).toHaveBeenCalledWith(expect.any(String), [{ externalProductId: 'item-1', externalSkuId: 'sku-1', price: '50000' }]);
    const { rows } = await testPool().query('select stock_sync, stock_sync_error from channel.listings where shop_id = $1', [shopId]);
    expect(rows).toEqual([{ stock_sync: 'pending', stock_sync_error: null }]);
  });

  it('AC-18: hai gian hàng cùng công ty lập phiếu đầu kỳ cùng lúc → đúng một 200, một 422, một phiếu', async () => {
    const create = fakeStocktake();
    const c = await createCompany({ optionalModules: ['channel'] });
    const [a, b] = [await connectingShop(c), await connectingShop(c)];
    const res = await Promise.all([a, b].map((id) => setup(c, id, { openingStock: 'stocktake' })));
    expect(res.map((r) => r.status).sort()).toEqual([200, 422]);
    expect(res.find((r) => r.status === 422)!.body.errors.openingStock).toMatch(/Công ty đang chờ/);
    const { rows } = await testPool().query(
      'select count(*)::int as n from channel.shops where company_id = $1 and opening_stocktake_id is not null',
      [c.companyId],
    );
    expect(rows[0].n).toBe(1);
    expect(create.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe('quyền của thiết lập (AC-S1)', () => {
  it('401 thiếu token; 403 Sale, Kho (C1-01q); 403 module_disabled; 404 gian hàng công ty khác', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const shopId = await connectingShop(c);
    expect((await app().get(`/api/v1/channel/shops/${shopId}/setup`)).status).toBe(401);
    for (const role of ['sale', 'warehouse'] as const) {
      const m = await addMember(c.companyId, role);
      const res = await app().post(`/api/v1/channel/shops/${shopId}/setup`).set('Authorization', `Bearer ${m.token}`).send({});
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('forbidden');
    }
    const other = await createCompany({ optionalModules: ['channel'] });
    expect((await preview(other, shopId)).status).toBe(404);
    await setModuleEnabled(c.companyId, 'channel', false);
    const off = await preview(c, shopId);
    expect(off.status).toBe(403);
    expect(off.body.code).toBe('module_disabled');
  });
});
