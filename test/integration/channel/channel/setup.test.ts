import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ShopSetupPreview, ShopSetupResult } from '#src/modules/channel/channel/api/schemas.ts';
import { MarketplaceError, type RemoteSku } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { type ListingVariant, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { fakeAdapter } from './helpers.ts';

const variant = (sku: string): ListingVariant => ({
  id: randomUUID(),
  productId: randomUUID(),
  productName: 'Áo',
  sku,
  categoryId: randomUUID(),
  attributesLabel: '',
  archived: false,
  description: null,
  weightG: 200,
  lengthMm: 100,
  widthMm: 100,
  heightMm: 10,
});
const onPlatform = variant('CMR-SAN-1');
const notOnPlatform = variant('CMR-CHUA-LEN');

setProductPort({
  variants: async (ids) => [onPlatform, notOnPlatform].filter((v) => !ids || ids.includes(v.id)),
  standardPrices: async (ids) => new Map(ids.map((id) => [id, new Decimal(50000)])),
  availableOf: async (ids) => new Map(ids.map((id) => [id, 9])),
});

const getSkus = vi.fn(async (_t: string, sellerSkus: readonly string[]): Promise<RemoteSku[]> =>
  sellerSkus
    .filter((s) => s === 'CMR-SAN-1')
    .map((s) => ({
      externalProductId: 'item-1',
      externalSkuId: 'sku-1',
      sellerSku: s,
      title: 'Áo trên sàn',
      state: 'live',
      rejectReason: null,
      quantity: 4,
    })),
);
let sàn: 'up' | 'down' = 'up';
const updatePriceQuantity = vi.fn(async (_t: string, items: readonly { externalSkuId: string }[]) => {
  if (sàn === 'down') throw new MarketplaceError('unavailable', '901');
  return items.map((i) => ({ externalSkuId: i.externalSkuId, ok: true as const }));
});
registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
    },
    getSkus,
    updatePriceQuantity,
  }),
);
afterAll(() => {
  resetAdapters();
  setProductPort(null);
});

const app = () => request(testApp());
let company: Awaited<ReturnType<typeof createCompany>>;
let shopId: string;
const auth = (r: request.Test) => r.set('Authorization', `Bearer ${company.ceo.token}`);
const setup = (body: object) => auth(app().post(`/api/v1/channel/shops/${shopId}/setup`)).send(body);

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
  const res = await auth(app().post('/api/v1/channel/shops/lazada/token')).send({
    accessToken: `tok-${randomUUID().slice(0, 12)}`,
  });
  shopId = res.body.shop.id;
});

describe('thiết lập lần đầu', () => {
  it('gợi ý SKU sàn có SellerSku trùng SKU Commerio, chỉ hỏi sàn theo SKU của mình', async () => {
    const res = await auth(app().get(`/api/v1/channel/shops/${shopId}/setup`));
    expect(res.status).toBe(200);
    expect(ShopSetupPreview.parse(res.body)).toEqual({
      suggestions: [
        { externalSkuId: 'sku-1', title: 'Áo trên sàn', variantId: onPlatform.id, sku: 'CMR-SAN-1', available: 9, platformStock: 4 },
      ],
      unmatchedRemote: 0,
    });
    expect(getSkus).toHaveBeenCalledWith(expect.any(String), ['CMR-SAN-1', 'CMR-CHUA-LEN']);
  });

  it('kiểm đầu vào: mốc tương lai, stocktake chưa hỗ trợ, SKU không có trong gợi ý', async () => {
    const res = await setup({
      externalSkuIds: ['sku-khong-co'],
      openingStock: 'stocktake',
      orderCutoffAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.errors).sort()).toEqual(['externalSkuIds', 'openingStock', 'orderCutoffAt']);
  });

  it('ghép, đẩy khả dụng, gian hàng connecting → active; đọc lại listing live và lịch sử', async () => {
    const cutoff = new Date(Date.now() - 3_600_000).toISOString();
    const res = await setup({ externalSkuIds: ['sku-1'], openingStock: 'push', orderCutoffAt: cutoff });
    expect(res.status).toBe(200);
    expect(ShopSetupResult.parse(res.body)).toMatchObject({ matched: 1, stocktakeNumber: null, shop: { status: 'active' } });
    expect(res.body.shop.orderCutoffAt).toBe(cutoff);
    expect(updatePriceQuantity).toHaveBeenCalledWith(expect.any(String), [
      { externalProductId: 'item-1', externalSkuId: 'sku-1', price: '50000', quantity: 9 },
    ]);
    const { rows } = await testPool().query('select status, stock_sync, platform_stock, seller_sku from channel.listings where shop_id = $1', [shopId]);
    expect(rows).toEqual([{ status: 'live', stock_sync: 'synced', platform_stock: 9, seller_sku: 'CMR-SAN-1' }]);
    const history = await testPool().query(
      `select entity_type, from_state, to_state, action from core.state_transitions
       where entity_id = $1 or entity_id = (select id from channel.listings where shop_id = $1) order by id`,
      [shopId],
    );
    expect(history.rows.slice(-2)).toEqual([
      { entity_type: 'listings', from_state: null, to_state: 'live', action: 'match' },
      { entity_type: 'shops', from_state: 'connecting', to_state: 'active', action: 'finish_setup' },
    ]);
  });

  it('đã thiết lập: 409 invalid_transition', async () => {
    const res = await auth(app().get(`/api/v1/channel/shops/${shopId}/setup`));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('invalid_transition');
  });
});

describe('ngắt kèm đẩy tồn 0', () => {
  it('sàn lỗi: 422 zero_stock_unavailable, gian hàng chưa ngắt', async () => {
    sàn = 'down';
    const shop = await auth(app().get(`/api/v1/channel/shops/${shopId}`));
    const res = await auth(app().post(`/api/v1/channel/shops/${shopId}/disconnect`)).send({ version: shop.body.version, zeroStock: true });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('zero_stock_unavailable');
    expect((await auth(app().get(`/api/v1/channel/shops/${shopId}`))).body.status).toBe('active');
    sàn = 'up';
  });

  it('đẩy tồn 0 cho listing còn trên sàn rồi ngắt', async () => {
    updatePriceQuantity.mockClear();
    const shop = await auth(app().get(`/api/v1/channel/shops/${shopId}`));
    const res = await auth(app().post(`/api/v1/channel/shops/${shopId}/disconnect`)).send({ version: shop.body.version, zeroStock: true });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('disconnected');
    expect(updatePriceQuantity).toHaveBeenCalledWith(expect.any(String), [
      { externalProductId: 'item-1', externalSkuId: 'sku-1', quantity: 0 },
    ]);
  });
});
