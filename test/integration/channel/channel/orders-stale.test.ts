// Đơn chưa cập nhật (#223; Documents/21 §18.6.6, 25 E28): gian hàng mất uỷ quyền, hoặc 15 phút chưa có lượt lấy đơn nào
// xong trọn, thì SKU bán trên đó không được cập nhật tồn lên MỌI gian hàng của công ty (số có thể bán chưa trừ đơn bán
// bên đó). Sàn giả: adapter thay bằng `registerAdapter`, không gọi sàn thật.
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HoldJob } from '#src/modules/core/index.ts';
import { stopJobs } from '#src/modules/core/platform/service/jobs/boss.ts';
import { runStockPush } from '#src/modules/channel/channel/service/background.ts';
import { syncListings } from '#src/modules/channel/channel/service/listing-sync.ts';
import { MarketplaceError, type PerSkuResult, type PriceQuantity, type RemoteSku } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { pullShopOrders } from '#src/modules/channel/channel/service/order-pull.ts';
import { type ListingVariant, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { fakeAdapter } from './helpers.ts';

const variant = (sku: string): ListingVariant => ({
  id: randomUUID(),
  productId: randomUUID(),
  productName: 'Bình',
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
/** `shared` bán ở cả Lazada và TikTok; `own` chỉ bán ở TikTok. */
const shared = variant('ST-SHARED');
const own = variant('ST-OWN');
const available = new Map<string, number>();
const port = {
  variants: async (ids?: readonly string[]) => [shared, own].filter((v) => !ids || ids.includes(v.id)),
  standardPrices: async (ids: readonly string[]) => new Map(ids.map((id) => [id, new Decimal(50000)])),
  availableOf: async (ids: readonly string[]) =>
    new Map(ids.flatMap((id): [string, number][] => (available.has(id) ? [[id, available.get(id)!]] : []))),
};
setProductPort(port);

type Platform = 'lazada' | 'tiktok';
/** Sàn giả theo sàn: lấy đơn lỗi, lấy đơn không bao giờ hết trang, tồn trên sàn, lỗi token khi đẩy. */
const fail: Record<Platform, MarketplaceError | null> = { lazada: null, tiktok: null };
const endless: Record<Platform, boolean> = { lazada: false, tiktok: false };
const unauthorizedPush: Record<Platform, boolean> = { lazada: false, tiktok: false };
const remote = new Map<string, number>();
type PushFn = (t: string, items: readonly PriceQuantity[]) => Promise<PerSkuResult[]>;
const pushes = {} as Record<Platform, ReturnType<typeof vi.fn<PushFn>>>;
function platformAdapter(platform: Platform) {
  pushes[platform] = vi.fn<PushFn>(async (_t, items) => {
    if (unauthorizedPush[platform]) throw new MarketplaceError('unauthorized', 'IllegalAccessToken');
    return items.map((i): PerSkuResult => ({ externalSkuId: i.externalSkuId, ok: true }));
  });
  return fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: `Shop ${platform}`, region: 'VN' };
    },
    async listOrders(_t, _since, cursor) {
      if (fail[platform]) throw fail[platform];
      return { orders: [], nextCursor: endless[platform] ? `c${Number(cursor?.slice(1) ?? 0) + 1}` : null, safeUntil: null };
    },
    getOrder: async () => {
      throw new Error('không có đơn');
    },
    async getSkus(_t, sellerSkus): Promise<RemoteSku[]> {
      return sellerSkus.flatMap((s) => {
        const q = remote.get(`${platform}:${s}`);
        return q === undefined
          ? []
          : [{ externalProductId: `item-${s}`, externalSkuId: `${platform}-${s}`, sellerSku: s, title: s, state: 'live' as const, rejectReason: null, quantity: q, sellableQuantity: q }];
      });
    },
    updatePriceQuantity: (t, items) => pushes[platform](t, items),
  });
}
registerAdapter('lazada', platformAdapter('lazada'));
registerAdapter('tiktok', platformAdapter('tiktok'));
afterAll(async () => {
  resetAdapters();
  setProductPort(null);
  await stopJobs();
});

const app = () => request(testApp());
let company: Awaited<ReturnType<typeof createCompany>>;
const shopIds = {} as Record<Platform, string>;
const auth = (r: request.Test) => r.set('Authorization', `Bearer ${company.ceo.token}`);
const sent = (platform: Platform, v: ListingVariant) =>
  pushes[platform].mock.calls.flatMap(([, items]) => items).find((i) => i.externalSkuId === `${platform}-${v.sku}`);

async function setShop(platform: Platform, cols: string) {
  await testPool().query(`update channel.shops set ${cols} where id = $1`, [shopIds[platform]]);
}
async function listing(platform: Platform, v: ListingVariant) {
  const { rows } = await testPool().query('select * from channel.listings where shop_id = $1 and variant_id = $2', [shopIds[platform], v.id]);
  return rows[0];
}
async function jobs(name: string, platform: Platform) {
  const { rowCount } = await testPool().query(
    "select 1 from pgboss.job where name = $1 and data->>'shopId' = $2 and state = 'created'",
    [name, shopIds[platform]],
  );
  return rowCount;
}

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
  for (const platform of ['lazada', 'tiktok'] as const) {
    const res = await auth(app().post(`/api/v1/channel/shops/${platform}/token`)).send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
    shopIds[platform] = res.body.shop.id;
    const listed = platform === 'lazada' ? [shared] : [shared, own];
    for (const v of listed) {
      await testPool().query(
        `insert into channel.listings (company_id, shop_id, variant_id, external_product_id, external_sku_id, seller_sku, status)
         values ($1, $2, $3, $4, $5, $6, 'live')`,
        [company.companyId, shopIds[platform], v.id, `item-${v.sku}`, `${platform}-${v.sku}`, v.sku],
      );
    }
  }
});

beforeEach(async () => {
  for (const platform of ['lazada', 'tiktok'] as const) {
    await setShop(platform, "status = 'active', order_cutoff_at = now() - interval '1 day', open_orders_pulled_at = now(), orders_pulled_ok_at = now()");
    await testPool().query(
      `update channel.listings set stock_sync = 'pending', price_sync = 'synced', listed_price = 50000, platform_stock = 5,
         stock_sync_error = null, price_sync_error = null where shop_id = $1`,
      [shopIds[platform]],
    );
    fail[platform] = null;
    endless[platform] = false;
    unauthorizedPush[platform] = false;
    pushes[platform].mockClear();
    await testPool().query("delete from pgboss.job where data->>'shopId' = $1 and name like 'channel.%'", [shopIds[platform]]);
  }
  for (const v of [shared, own]) available.set(v.id, 4);
  remote.clear();
});

const push = (platform: Platform) => runStockPush(port, { companyId: company.companyId, shopId: shopIds[platform] });

describe('đơn chưa cập nhật chặn đẩy tồn trên mọi gian hàng (#223)', () => {
  it('Lazada mất uỷ quyền → TikTok không đẩy tồn SKU bán chung, vẫn đẩy SKU chỉ bán ở TikTok; giá vẫn đẩy', async () => {
    await setShop('lazada', "status = 'needs_reauth', orders_pulled_ok_at = null");
    await testPool().query(`update channel.listings set price_sync = 'pending' where shop_id = $1`, [shopIds.tiktok]);
    await push('tiktok');
    expect(sent('tiktok', shared)).toEqual({ externalProductId: `item-${shared.sku}`, externalSkuId: `tiktok-${shared.sku}`, price: '50000' });
    expect(sent('tiktok', own)).toMatchObject({ quantity: 4 });
    expect(await listing('tiktok', shared)).toMatchObject({ stock_sync: 'pending', stock_sync_error: null, price_sync: 'synced' });
    expect(await listing('tiktok', own)).toMatchObject({ stock_sync: 'synced', platform_stock: 4 });
  });

  it('Lazada lấy đơn xong trọn → mốc là giờ bắt đầu lượt, xếp đẩy tồn cho mọi gian hàng, TikTok đẩy được SKU bán chung', async () => {
    await setShop('lazada', 'orders_pulled_ok_at = null');
    await push('tiktok');
    expect(sent('tiktok', shared)?.quantity).toBeUndefined();

    const before = Date.now();
    await pullShopOrders(company.companyId, shopIds.lazada);
    const { rows } = await testPool().query('select orders_pulled_ok_at from channel.shops where id = $1', [shopIds.lazada]);
    const at = (rows[0].orders_pulled_ok_at as Date).getTime();
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(Date.now());
    expect(await jobs('channel.stock_push', 'tiktok')).toBe(1);

    pushes.tiktok.mockClear();
    await push('tiktok');
    expect(sent('tiktok', shared)).toMatchObject({ quantity: 4 });
  });

  it('ngưỡng 15 phút: lượt xong trọn gần nhất 5 phút trước vẫn đẩy; 16 phút trước thì chặn', async () => {
    await setShop('lazada', "orders_pulled_ok_at = now() - interval '5 minutes'");
    await push('tiktok');
    expect(sent('tiktok', shared)).toMatchObject({ quantity: 4 });

    await testPool().query(`update channel.listings set stock_sync = 'pending' where shop_id = $1`, [shopIds.tiktok]);
    pushes.tiktok.mockClear();
    await setShop('lazada', "orders_pulled_ok_at = now() - interval '16 minutes'");
    await push('tiktok');
    expect(sent('tiktok', shared)?.quantity).toBeUndefined();
  });

  it('lấy đơn lỗi → không đặt mốc; lấy đơn không hết trang → không đặt mốc', async () => {
    await setShop('lazada', "orders_pulled_ok_at = now() - interval '20 minutes'");
    const old = (await testPool().query('select orders_pulled_ok_at from channel.shops where id = $1', [shopIds.lazada])).rows[0].orders_pulled_ok_at;
    fail.lazada = new MarketplaceError('unavailable', '901', 'Sàn bận');
    await expect(pullShopOrders(company.companyId, shopIds.lazada)).rejects.toThrow();
    fail.lazada = null;
    endless.lazada = true;
    await pullShopOrders(company.companyId, shopIds.lazada);
    const now = (await testPool().query('select orders_pulled_ok_at from channel.shops where id = $1', [shopIds.lazada])).rows[0].orders_pulled_ok_at;
    expect(now).toEqual(old);
    expect(await jobs('channel.stock_push', 'tiktok')).toBe(0);
  });

  it('đối chiếu TikTok bỏ qua SKU bán chung khi Lazada chưa cập nhật đơn: sàn thấp hơn hai lượt không bật Lệch tồn, không đẩy tăng', async () => {
    await setShop('lazada', "status = 'needs_reauth', orders_pulled_ok_at = null");
    await testPool().query(`update channel.listings set stock_sync = 'synced', platform_stock = 2 where shop_id = $1`, [shopIds.tiktok]);
    remote.set(`tiktok:${shared.sku}`, 2);
    remote.set(`tiktok:${own.sku}`, 4);
    await syncListings(port, company.companyId, shopIds.tiktok);
    await syncListings(port, company.companyId, shopIds.tiktok);
    expect(sent('tiktok', shared)?.quantity).toBeUndefined();
    expect(await listing('tiktok', shared)).toMatchObject({ stock_sync: 'synced', platform_stock: 2 });
  });

  it('gian hàng tự đẩy tồn mà đơn của chính nó chưa cập nhật → chỉ đẩy giá, xếp một lượt lấy đơn', async () => {
    await setShop('tiktok', 'orders_pulled_ok_at = null');
    await push('tiktok');
    expect(sent('tiktok', own)?.quantity).toBeUndefined();
    expect(await jobs('channel.order_pull', 'tiktok')).toBe(1);
  });

  it('sàn từ chối token khi đẩy tồn → việc được giữ (HoldJob), gian hàng mất uỷ quyền (21 §18.6.6 pendingJobs)', async () => {
    unauthorizedPush.tiktok = true;
    await expect(push('tiktok')).rejects.toBeInstanceOf(HoldJob);
    expect((await testPool().query('select status from channel.shops where id = $1', [shopIds.tiktok])).rows[0].status).toBe('needs_reauth');
  });

  it('CSDL chặn mốc lấy đơn ở gian hàng chưa có mốc bắt đầu lấy đơn', async () => {
    await expect(
      testPool().query("update channel.shops set status = 'connecting', order_cutoff_at = null, orders_pulled_ok_at = now() where id = $1", [shopIds.lazada]),
    ).rejects.toMatchObject({ constraint: 'shops_orders_pulled_ok_at' });
  });
});
