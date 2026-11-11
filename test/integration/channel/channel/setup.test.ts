import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { jobBoss } from '#src/modules/core/platform/service/jobs/boss.ts';
import { listingSyncQueue, tokenRefreshQueue } from '#src/modules/channel/channel/service/shop-jobs.ts';
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
  businessStatus: 'selling',
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
  it('gợi ý SKU sàn có SellerSku trùng SKU Commerio, chỉ hỏi sàn theo SKU của mình khi sàn chưa có listSkus', async () => {
    const res = await auth(app().get(`/api/v1/channel/shops/${shopId}/setup`));
    expect(res.status).toBe(200);
    expect(ShopSetupPreview.parse(res.body)).toEqual({
      suggestions: [
        { externalSkuId: 'sku-1', title: 'Áo trên sàn', match: 'sku', score: null, variantId: onPlatform.id, sku: 'CMR-SAN-1', available: 9, platformStock: 4, imageUrl: null, status: 'live' },
      ],
      unmatchedRemote: 0,
      nameMatchSkipped: false,
      proposedCutoffAt: expect.any(String),
      firstShopOfCompany: true,
    });
    expect(getSkus).toHaveBeenCalledWith(expect.any(String), ['CMR-SAN-1', 'CMR-CHUA-LEN']);
  });

  it('kiểm đầu vào: gian hàng đầu tiên gửi push, SKU không có trong gợi ý; orderCutoffAt bị bỏ qua (#198)', async () => {
    const res = await setup({
      externalSkuIds: ['sku-khong-co'],
      openingStock: 'push',
      orderCutoffAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.errors).sort()).toEqual(['externalSkuIds', 'openingStock']);
  });

  it('ghép, đẩy giá, gian hàng connecting → active; đọc lại listing live và lịch sử', async () => {
    // Công ty đã có gian hàng xong thiết lập thì gian hàng này mới được push (#198 A1).
    await testPool().query(
      "insert into channel.shops (company_id, platform, external_shop_id, shop_name, status, order_cutoff_at) values ($1, 'lazada', $2, 'Shop cũ', 'active', now())",
      [company.companyId, randomUUID()],
    );
    const res = await setup({ externalSkuIds: ['sku-1'], openingStock: 'push' });
    expect(res.status).toBe(200);
    expect(ShopSetupResult.parse(res.body)).toMatchObject({ matched: 1, stocktakeNumber: null, shop: { status: 'active' } });
    // Tồn đẩy sau lượt kéo đơn còn mở (#198 A10): lúc thiết lập chỉ đẩy giá.
    expect(updatePriceQuantity).toHaveBeenCalledWith(expect.any(String), [
      { externalProductId: 'item-1', externalSkuId: 'sku-1', price: '50000' },
    ]);
    const { rows } = await testPool().query('select status, stock_sync, platform_stock, seller_sku from channel.listings where shop_id = $1', [shopId]);
    expect(rows).toEqual([{ status: 'live', stock_sync: 'pending', platform_stock: 4, seller_sku: 'CMR-SAN-1' }]);
    const history = await testPool().query(
      `select entity_type, from_state, to_state, action from core.state_transitions
       where entity_id = $1 or entity_id = (select id from channel.listings where shop_id = $1) order by id`,
      [shopId],
    );
    expect(history.rows.slice(-2)).toEqual([
      { entity_type: 'listings', from_state: null, to_state: 'live', action: 'match' },
      { entity_type: 'shops', from_state: 'connecting', to_state: 'active', action: 'finish_setup' },
    ]);
    // #102 A3: gian hàng vừa active thì có lịch đồng bộ listing và làm mới token.
    const boss = await jobBoss();
    expect(await boss.getSchedules(listingSyncQueue.name, shopId)).toHaveLength(1);
    expect(await boss.getSchedules(tokenRefreshQueue.name, shopId)).toHaveLength(1);
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

// Hạn trả hàng nhập lúc thiết lập (H7, Documents/21 §18.6.2; #200 A3 luật chuyển tiếp). Mỗi ca một gian hàng mới của công
// ty đã có một gian hàng thiết lập xong, để ca `push` vẫn đúng khi gian hàng đầu tiên phải kiểm kê (#198).
describe('returnWindowDays ở thiết lập', () => {
  let co: Awaited<ReturnType<typeof createCompany>>;
  const tiktokSkus = vi.fn(async (): Promise<RemoteSku[]> => []);
  beforeAll(async () => {
    co = await createCompany({ optionalModules: ['channel'] });
    const first = await newShop();
    await testPool().query("update channel.shops set status = 'active', order_cutoff_at = now() - interval '1 day' where id = $1", [first]);
    registerAdapter(
      'tiktok',
      fakeAdapter({
        capabilities: { listingReview: true, hideBy: 'deactivate', splitLevel: 'sku', returnWindow: 'platform_status' },
        async getSeller(accessToken) {
          return { externalShopId: accessToken.slice(4), shopName: 'Shop TikTok thử', region: 'VN' };
        },
        getSkus: tiktokSkus,
        updatePriceQuantity,
      }),
    );
  });
  const coAuth = (r: request.Test) => r.set('Authorization', `Bearer ${co.ceo.token}`);
  async function newShop(platform = 'lazada'): Promise<string> {
    const res = await coAuth(app().post(`/api/v1/channel/shops/${platform}/token`)).send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
    expect(res.status).toBe(201);
    return res.body.shop.id;
  }
  const finish = (id: string, extra: object) =>
    coAuth(app().post(`/api/v1/channel/shops/${id}/setup`)).send({
      externalSkuIds: [],
      openingStock: 'push',
      orderCutoffAt: new Date(Date.now() - 3_600_000).toISOString(),
      ...extra,
    });
  const stored = async (id: string) =>
    (await testPool().query<{ status: string; return_window_days: number | null }>('select status, return_window_days from channel.shops where id = $1', [id])).rows[0];

  it('C1-01: Lazada (returnWindow = days) gửi 14 thì lưu 14, gian hàng active', async () => {
    const id = await newShop();
    const res = await finish(id, { returnWindowDays: 14 });
    expect(res.status).toBe(200);
    expect(ShopSetupResult.parse(res.body).shop).toMatchObject({ status: 'active', returnWindowDays: 14 });
    expect(await stored(id)).toEqual({ status: 'active', return_window_days: 14 });
  });

  it('ngoài 1–60, số lẻ, chuỗi thì 422 errors.returnWindowDays, gian hàng vẫn connecting', async () => {
    const id = await newShop();
    for (const bad of [0, 61, 1.5, '7']) {
      const res = await finish(id, { returnWindowDays: bad });
      expect(res.status, String(bad)).toBe(422);
      expect(res.body.code).toBe('validation_failed');
      expect(res.body.errors, String(bad)).toHaveProperty('returnWindowDays');
    }
    expect(await stored(id)).toEqual({ status: 'connecting', return_window_days: null });
  });

  it('chuyển tiếp đợt 2: không gửi hoặc gửi null thì vẫn thiết lập được, hạn để trống', async () => {
    for (const extra of [{}, { returnWindowDays: null }]) {
      const id = await newShop();
      const res = await finish(id, extra);
      expect(res.status).toBe(200);
      expect(await stored(id)).toEqual({ status: 'active', return_window_days: null });
    }
  });

  it('sàn returnWindow = platform_status: bỏ qua số gửi lên, lưu null', async () => {
    const id = await newShop('tiktok');
    const res = await finish(id, { returnWindowDays: 30 });
    expect(res.status).toBe(200);
    expect(ShopSetupResult.parse(res.body).shop).toMatchObject({
      status: 'active',
      returnWindowDays: null,
      capabilities: { returnWindow: 'platform_status' },
    });
    expect(await stored(id)).toEqual({ status: 'active', return_window_days: null });
  });
});
