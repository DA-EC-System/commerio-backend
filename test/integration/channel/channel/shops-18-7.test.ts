import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ShopCallbackResult, ShopDetail, ShopDisconnectConflict, ShopList } from '#src/modules/channel/channel/api/schemas.ts';
import { MarketplaceError, type RemoteSku } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { fakeAdapter } from './helpers.ts';

// Phần 18.7 của #200 (Documents/21 §18.7.1, §18.7.4, §18.7.8): số liệu trên `Shop`, `previousStatus` và `remoteSkuCount`
// ở kết quả nối, danh sách đơn ở 409 `shop_has_open_orders`. §18.7.3 ở `platforms.test.ts`.

const DAY = 24 * 3600_000;

const sku = (n: number, state: RemoteSku['state'] = 'live'): RemoteSku => ({
  externalProductId: `item-${n}`,
  externalSkuId: `sku-${n}`,
  sellerSku: `SKU-${n}`,
  title: `Sản phẩm ${n}`,
  state,
  rejectReason: null,
  quantity: 1,
});

// Token `tok-<seller>` đọc ra seller đó; code `c-<a>+<b>` ra nhiều gian hàng. Seller bắt đầu bằng `down` thì đọc SKU lỗi
// tạm của sàn, `boom` thì lỗi không phải của sàn, `empty` thì không có SKU nào; còn lại có ba SKU, một SKU đã xoá trên sàn.
registerAdapter(
  'lazada',
  fakeAdapter({
    authorizeUrl: (state) => `https://auth.fake/oauth/authorize?state=${encodeURIComponent(state)}`,
    async exchangeCode(params) {
      return params.code!.slice(2).split('+').map((id) => ({
        externalShopId: id,
        shopName: `Shop ${id.slice(0, 8)}`,
        region: 'VN',
        tokens: { accessToken: `tok-${id}`, refreshToken: null, accessExpiresAt: null, refreshExpiresAt: null },
      }));
    },
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: `Shop ${accessToken.slice(4, 12)}`, region: 'VN' };
    },
    async listSkus(accessToken) {
      if (accessToken.startsWith('tok-down')) throw new MarketplaceError('unavailable', 'ServiceTimeout');
      if (accessToken.startsWith('tok-boom')) throw new Error('lỗi lập trình giả');
      if (accessToken.startsWith('tok-empty')) return [];
      return [sku(1), sku(2, 'inactive'), sku(3, 'deleted')];
    },
  }),
);
afterAll(() => resetAdapters());

const app = () => request(testApp());
let company: Awaited<ReturnType<typeof createCompany>>;
const auth = (r: request.Test) => r.set('Authorization', `Bearer ${company.ceo.token}`);
const seller = (prefix = '') => `${prefix}${randomUUID().replace(/-/g, '').slice(0, 12)}`;

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
});

async function connect(sellerId: string, platform = 'lazada') {
  const res = await auth(app().post(`/api/v1/channel/shops/${platform}/token`)).send({ accessToken: `tok-${sellerId}` });
  expect([200, 201]).toContain(res.status);
  return ShopCallbackResult.parse(res.body);
}

async function shopDetail(id: string) {
  const res = await auth(app().get(`/api/v1/channel/shops/${id}`));
  expect(res.status).toBe(200);
  return ShopDetail.parse(res.body);
}

async function listed(id: string) {
  const res = await auth(app().get('/api/v1/channel/shops'));
  expect(res.status).toBe(200);
  return ShopList.parse(res.body).items.find((s) => s.id === id)!;
}

type OrderStatus = 'unpaid' | 'processing' | 'completed' | 'cancelled';

async function addOrder(shopId: string, status: OrderStatus, placedAt: Date | null) {
  const code = `DH-${randomUUID().slice(0, 8)}`;
  const externalOrderId = `SAN-${randomUUID().slice(0, 8)}`;
  const { rows } = await testPool().query<{ id: string }>(
    `insert into "order".orders (company_id, code, source, shop_id, external_order_id, status, outcome, placed_at, subtotal, total)
     values ($1, $2, 'marketplace', $3, $4, $5, $6, $7, 0, 0) returning id`,
    [company.companyId, code, shopId, externalOrderId, status, status === 'completed' ? 'full' : null, placedAt],
  );
  return { id: rows[0]!.id, code, externalOrderId };
}

const disconnect = (id: string, version: number) => auth(app().post(`/api/v1/channel/shops/${id}/disconnect`)).send({ version });

/** Đặt thẳng trạng thái (và mốc kéo đơn khi giả gian hàng đã thiết lập) để dựng ca nối lại. */
async function setStatus(id: string, status: string, cutoff: Date | null = null) {
  await testPool().query('update channel.shops set status = $2, order_cutoff_at = coalesce($3, order_cutoff_at), version = version + 1 where id = $1', [
    id,
    status,
    cutoff,
  ]);
}

describe('§18.7.1 số liệu trên Shop', () => {
  it('gian hàng mới: đếm 0, statusChangedAt bằng createdAt, feeConfigVersion null, ở cả danh sách và chi tiết', async () => {
    const { shop } = await connect(seller());
    expect(shop).toMatchObject({ pendingOrderCount: 0, orders7d: 0, feeConfigVersion: null, statusChangedAt: shop.createdAt });
    const fields = (s: typeof shop) => [s.pendingOrderCount, s.orders7d, s.statusChangedAt, s.feeConfigVersion];
    expect(fields(await listed(shop.id))).toEqual([0, 0, shop.createdAt, null]);
    expect(fields(await shopDetail(shop.id))).toEqual([0, 0, shop.createdAt, null]);
  });

  it('pendingOrderCount đếm đơn chưa completed, cancelled; orders7d theo placedAt trong 7 × 24 giờ; mỗi gian hàng đếm riêng', async () => {
    const a = (await connect(seller())).shop;
    const b = (await connect(seller())).shop;
    const now = Date.now();
    await addOrder(a.id, 'unpaid', new Date(now - DAY));
    await addOrder(a.id, 'processing', new Date(now - 8 * DAY));
    await addOrder(a.id, 'completed', new Date(now - 2 * DAY));
    await addOrder(a.id, 'cancelled', new Date(now - 7 * DAY + 60_000));
    await addOrder(a.id, 'processing', null);
    await addOrder(b.id, 'completed', new Date(now - 3 * DAY));

    expect(await listed(a.id)).toMatchObject({ pendingOrderCount: 3, orders7d: 3 });
    expect(await listed(b.id)).toMatchObject({ pendingOrderCount: 0, orders7d: 1 });
    expect(await shopDetail(a.id)).toMatchObject({ pendingOrderCount: 3, orders7d: 3 });
  });

  it('đổi trạng thái thì statusChangedAt là lần chuyển gần nhất trong statusHistory', async () => {
    const { shop } = await connect(seller());
    const res = await disconnect(shop.id, shop.version);
    expect(res.status).toBe(200);
    expect(res.body.statusChangedAt).not.toBe(shop.createdAt);
    const detail = await shopDetail(shop.id);
    expect(detail.statusChangedAt).toBe(detail.statusHistory.at(-1)!.at);
    expect(detail.statusChangedAt).toBe(res.body.statusChangedAt);
    expect(detail.statusHistory.at(-1)).toMatchObject({ from: 'connecting', to: 'disconnected' });
  });

  it('đổi trạng thái hai lần: statusChangedAt theo lần sau cùng, không phải lần đầu', async () => {
    const id = seller();
    const { shop } = await connect(id);
    expect((await disconnect(shop.id, shop.version)).status).toBe(200);
    const first = (await shopDetail(shop.id)).statusChangedAt;
    await connect(id);
    const detail = await shopDetail(shop.id);
    expect(detail.statusHistory.map((h) => h.to)).toEqual(['connecting', 'disconnected', 'connecting']);
    expect(detail.statusChangedAt).toBe(detail.statusHistory.at(-1)!.at);
    expect(Date.parse(detail.statusChangedAt)).toBeGreaterThanOrEqual(Date.parse(first));
  });
});

describe('§18.7.4 previousStatus và remoteSkuCount ở kết quả nối', () => {
  it('nối lần đầu: previousStatus null, remoteSkuCount không tính SKU đã xoá; gốc response không có hai trường', async () => {
    const body = await connect(seller());
    expect(body.shops).toHaveLength(1);
    expect(body.shops[0]).toMatchObject({ created: true, previousStatus: null, remoteSkuCount: 2 });
    expect(body).not.toHaveProperty('previousStatus');
    expect(body).not.toHaveProperty('remoteSkuCount');
  });

  it('nối lại: previousStatus là trạng thái ngay trước lần nối (connecting, rồi disconnected)', async () => {
    const id = seller();
    const first = (await connect(id)).shop;
    expect((await connect(id)).shops[0]).toMatchObject({ created: false, previousStatus: 'connecting', remoteSkuCount: 2 });
    expect((await disconnect(first.id, (await shopDetail(first.id)).version)).status).toBe(200);
    const again = await connect(id);
    expect(again.shops[0]).toMatchObject({ created: false, previousStatus: 'disconnected' });
    expect(again.shop.status).toBe('connecting');
  });

  it('callback nhiều gian hàng: mỗi phần tử có previousStatus, remoteSkuCount của gian hàng đó', async () => {
    const old = seller('empty');
    await connect(old);
    const fresh = seller();
    const url = await auth(app().get('/api/v1/channel/shops/lazada/authorize-url'));
    expect(url.status).toBe(200);
    const state = new URL(url.body.url).searchParams.get('state');
    const res = await auth(app().post('/api/v1/channel/shops/lazada/callback')).send({ state, params: { code: `c-${old}+${fresh}` } });
    expect(res.status).toBe(201);
    const body = ShopCallbackResult.parse(res.body);
    const byShop = new Map(body.shops.map((s) => [s.shop.externalShopId, s]));
    expect(byShop.get(old)).toMatchObject({ created: false, previousStatus: 'connecting', remoteSkuCount: 0 });
    expect(byShop.get(fresh)).toMatchObject({ created: true, previousStatus: null, remoteSkuCount: 2 });
  });

  it('nối lại gian hàng needs_reauth chưa thiết lập: previousStatus needs_reauth, về connecting, reconnect null', async () => {
    const id = seller();
    const { shop } = await connect(id);
    await setStatus(shop.id, 'needs_reauth');
    const body = await connect(id);
    expect(body.shops[0]).toMatchObject({ created: false, previousStatus: 'needs_reauth', reconnect: null, remoteSkuCount: 2 });
    expect(body.shop.status).toBe('connecting');
  });

  it('chỉ thay token cho gian hàng active: previousStatus active, vẫn đếm SKU', async () => {
    const id = seller();
    const { shop } = await connect(id);
    await setStatus(shop.id, 'active', new Date(Date.now() - DAY));
    const body = await connect(id);
    expect(body.shops[0]).toMatchObject({ created: false, previousStatus: 'active', reconnect: null, remoteSkuCount: 2 });
    expect(body.shop.status).toBe('active');
  });

  it.each(['needs_reauth', 'disconnected'] as const)(
    'nối lại gian hàng đã thiết lập từ %s: reconnect khác null, gian hàng active',
    async (from) => {
      const id = seller();
      const { shop } = await connect(id);
      await setStatus(shop.id, 'active', new Date(Date.now() - DAY));
      if (from === 'disconnected') {
        expect((await disconnect(shop.id, (await shopDetail(shop.id)).version)).status).toBe(200);
      } else {
        await setStatus(shop.id, 'needs_reauth');
      }
      const body = await connect(id);
      expect(body.shops[0]).toMatchObject({ created: false, previousStatus: from, remoteSkuCount: 2 });
      expect(body.shops[0]!.reconnect).not.toBeNull();
      expect(body.shop.status).toBe('active');
    },
  );

  it('sàn lỗi khi đọc SKU thì vẫn nối được, remoteSkuCount null', async () => {
    const body = await connect(seller('down'));
    expect(body.shops[0]).toMatchObject({ created: true, remoteSkuCount: null });
  });

  it('lỗi không phải của sàn khi đọc SKU cũng không chặn việc nối, remoteSkuCount null', async () => {
    const body = await connect(seller('boom'));
    expect(body.shops[0]).toMatchObject({ created: true, remoteSkuCount: null });
  });

  it('adapter không có listSkus thì remoteSkuCount null', async () => {
    registerAdapter(
      'shopee',
      fakeAdapter({
        async getSeller(accessToken) {
          return { externalShopId: accessToken.slice(4), shopName: 'Shop không đọc SKU', region: 'VN' };
        },
      }),
    );
    const body = await connect(seller(), 'shopee');
    expect(body.shops[0]).toMatchObject({ created: true, previousStatus: null, remoteSkuCount: null });
  });

  // #198/#284: Lazada đọc từng trang quá hạn 10 giây với gian hàng vài trăm sản phẩm; adapter có tổng rẻ thì dùng tổng.
  it('adapter có countSkus thì dùng tổng đó, không đọc listSkus; countSkus lỗi thì null', async () => {
    let listed = 0;
    registerAdapter(
      'tiktok',
      fakeAdapter({
        async getSeller(accessToken) {
          return { externalShopId: accessToken.slice(4), shopName: 'Shop đếm bằng tổng', region: 'VN' };
        },
        async countSkus(accessToken) {
          if (accessToken.startsWith('tok-down')) throw new MarketplaceError('unavailable', 'ServiceTimeout');
          return 305;
        },
        async listSkus() {
          listed++;
          return [sku(1)];
        },
      }),
    );
    expect((await connect(seller(), 'tiktok')).shops[0]).toMatchObject({ created: true, remoteSkuCount: 305 });
    expect((await connect(seller('down'), 'tiktok')).shops[0]).toMatchObject({ created: true, remoteSkuCount: null });
    expect(listed).toBe(0);
  });

});

describe('§18.7.8 409 shop_has_open_orders kèm danh sách đơn', () => {
  it('tối đa 20 đơn chưa xong, cũ nhất trước, kèm id, code, externalOrderId; openOrders là tổng', async () => {
    const { shop } = await connect(seller());
    const base = Date.now() - 30 * DAY;
    const open: Awaited<ReturnType<typeof addOrder>>[] = [];
    // Chèn mới trước để thứ tự chèn khác thứ tự đặt.
    for (let i = 24; i >= 0; i--) open.unshift(await addOrder(shop.id, i % 2 ? 'unpaid' : 'processing', new Date(base + i * 3600_000)));
    await addOrder(shop.id, 'completed', new Date(base - DAY));
    await addOrder(shop.id, 'cancelled', new Date(base - DAY));

    const res = await disconnect(shop.id, shop.version);
    expect(res.status).toBe(409);
    const body = ShopDisconnectConflict.parse(res.body);
    expect(body).toMatchObject({ code: 'shop_has_open_orders', openOrders: 25 });
    expect(body.orders).toEqual(open.slice(0, 20));
  });
});
