import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HoldJob } from '#src/modules/core/index.ts';
import { jobBoss, stopJobs } from '#src/modules/core/platform/service/jobs/boss.ts';
import { runListingSync, runOrderPull, runTokenRefresh } from '#src/modules/channel/channel/service/background.ts';
import { MarketplaceError, type TokenSet } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import {
  listingSyncQueue,
  orderPullQueue,
  reconcileShopJobs,
  startShopJobs,
  tokenRefreshQueue,
} from '#src/modules/channel/channel/service/shop-jobs.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { fakeAdapter } from './helpers.ts';

const HOUR = 3_600_000;
const port = {
  variants: async () => [],
  standardPrices: async (ids: readonly string[]) => new Map(ids.map((id) => [id, new Decimal(1000)])),
  availableOf: async () => new Map<string, number>(),
};
setProductPort(port);

/** Hành vi sàn giả, từng test đặt lại. */
const sàn = {
  skusUnauthorized: false,
  ordersUnauthorized: false,
  returnsError: null as MarketplaceError | null,
  listOrders: vi.fn(),
  listReturns: vi.fn(),
  refresh: vi.fn(async (refreshToken: string): Promise<TokenSet> => ({
    accessToken: `tok-new-${refreshToken}`,
    refreshToken,
    accessExpiresAt: new Date(Date.now() + 7 * 24 * HOUR),
    refreshExpiresAt: new Date(Date.now() + 30 * 24 * HOUR),
  })),
};
registerAdapter(
  'lazada',
  fakeAdapter({
    refreshToken: (t) => sàn.refresh(t),
    async getSeller(accessToken) {
      return { externalShopId: accessToken.replace(/^tok-(new-)?/, '').slice(0, 12), shopName: 'Shop thử', region: 'VN' };
    },
    async getSkus() {
      if (sàn.skusUnauthorized) throw new MarketplaceError('unauthorized', 'IllegalAccessToken', 'Invalid token');
      return [];
    },
    updatePriceQuantity: async (_t, items) => items.map((i) => ({ externalSkuId: i.externalSkuId, ok: true })),
    async listOrders() {
      sàn.listOrders();
      if (sàn.ordersUnauthorized) throw new MarketplaceError('unauthorized', 'IllegalAccessToken', 'Invalid token');
      return { orders: [], nextCursor: null, safeUntil: null };
    },
    getOrder: async () => {
      throw new Error('không có đơn nào để gọi chi tiết');
    },
    async listReturns() {
      sàn.listReturns();
      if (sàn.returnsError) throw sàn.returnsError;
      return { items: [], nextCursor: null };
    },
  }),
);
afterAll(async () => {
  resetAdapters();
  setProductPort(null);
  await stopJobs();
});
beforeEach(() => {
  sàn.skusUnauthorized = false;
  sàn.ordersUnauthorized = false;
  sàn.returnsError = null;
  sàn.listReturns.mockClear();
  sàn.refresh.mockClear();
  sàn.listOrders.mockClear();
});

const app = () => request(testApp());

/** Gian hàng `active` của một công ty mới, có một listing `live` để lượt đồng bộ phải gọi sàn. */
async function activeShop(opts: { refreshToken?: string } = {}) {
  const company = await createCompany({ optionalModules: ['channel'] });
  const seller = randomUUID().replace(/-/g, '').slice(0, 12);
  const res = await app()
    .post('/api/v1/channel/shops/lazada/token')
    .set('Authorization', `Bearer ${company.ceo.token}`)
    .send({ accessToken: `tok-${seller}`, ...(opts.refreshToken ? { refreshToken: opts.refreshToken } : {}) });
  expect(res.status).toBe(201);
  const shopId: string = res.body.shop.id;
  await testPool().query(`update channel.shops set status = 'active', order_cutoff_at = now() where id = $1`, [shopId]);
  await testPool().query(
    `insert into channel.listings (company_id, shop_id, variant_id, status, seller_sku, external_product_id, external_sku_id, stock_sync, price_sync)
     values ($1, $2, $3, 'live', 'CMR-BG', 'item-1', 'sku-1', 'synced', 'synced')`,
    [company.companyId, shopId, randomUUID()],
  );
  return { company, shopId, seller, data: { companyId: company.companyId, shopId } };
}

const shopStatus = async (id: string) =>
  (await testPool().query('select status, access_expires_at from channel.shops where id = $1', [id])).rows[0];
const schedules = async (shopId: string) => {
  const boss = await jobBoss();
  return [
    ...(await boss.getSchedules(listingSyncQueue.name, shopId)),
    ...(await boss.getSchedules(orderPullQueue.name, shopId)),
    ...(await boss.getSchedules(tokenRefreshQueue.name, shopId)),
  ].map((s) => s.name);
};

describe('lịch việc nền của gian hàng (#102 A3)', () => {
  it('AC-3: worker khởi động thì mọi gian hàng active có lịch đồng bộ listing, kéo đơn và làm mới token; gian hàng chưa active thì không', async () => {
    const { shopId } = await activeShop();
    const company = await createCompany({ optionalModules: ['channel'] });
    const connecting = await app()
      .post('/api/v1/channel/shops/lazada/token')
      .set('Authorization', `Bearer ${company.ceo.token}`)
      .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
    await reconcileShopJobs();
    expect((await schedules(shopId)).sort()).toEqual([listingSyncQueue.name, orderPullQueue.name, tokenRefreshQueue.name]);
    expect(await schedules(connecting.body.shop.id)).toEqual([]);
  });

  it('gian hàng đã ngắt mà lịch còn sót thì lượt đồng bộ tự bỏ lịch, không gọi sàn', async () => {
    const { shopId, data } = await activeShop();
    await startShopJobs(data.companyId, shopId);
    await testPool().query(`update channel.shops set status = 'disconnected' where id = $1`, [shopId]);
    sàn.skusUnauthorized = true;
    await runListingSync(port, data);
    expect(await schedules(shopId)).toEqual([]);
  });
});

describe('mất token: giữ việc, nối lại thì chạy tiếp (#102 A5)', () => {
  it('AC-4: sàn từ chối token khi đồng bộ thì gian hàng needs_reauth, lịch dừng, việc được giữ', async () => {
    const { shopId, data } = await activeShop();
    await startShopJobs(data.companyId, shopId);
    sàn.skusUnauthorized = true;
    await expect(runListingSync(port, data)).rejects.toBeInstanceOf(HoldJob);
    expect(await shopStatus(shopId)).toMatchObject({ status: 'needs_reauth' });
    expect(await schedules(shopId)).toEqual([]);
  });

  it('AC-4: pendingJobs đếm việc đang giữ; nối lại thì jobsRun bằng số đó, lịch bật lại', async () => {
    const { company, shopId, seller, data } = await activeShop();
    const boss = await jobBoss();
    await boss.createQueue('platform.held');
    await boss.send('platform.held', { ...data, queue: listingSyncQueue.name });
    await testPool().query(`update channel.shops set status = 'needs_reauth' where id = $1`, [shopId]);
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${company.ceo.token}`);

    const before = await auth(app().get(`/api/v1/channel/shops/${shopId}`));
    expect(before.body).toMatchObject({ status: 'needs_reauth', pendingJobs: 1 });

    const res = await auth(app().post('/api/v1/channel/shops/lazada/token')).send({ accessToken: `tok-${seller}` });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ shop: { status: 'active', pendingJobs: 0 }, reconnect: { jobsRun: 1 } });
    expect((await schedules(shopId)).sort()).toEqual([listingSyncQueue.name, orderPullQueue.name, tokenRefreshQueue.name]);
    expect(await boss.findJobs(listingSyncQueue.name, { data: { shopId } })).not.toHaveLength(0);
  });

  it('ngắt gian hàng thì bỏ lịch và bỏ việc đang giữ (§18.1 "Hàng chờ bỏ")', async () => {
    const { company, shopId, data } = await activeShop();
    await startShopJobs(data.companyId, shopId);
    const boss = await jobBoss();
    await boss.createQueue('platform.held');
    await boss.send('platform.held', { ...data, queue: listingSyncQueue.name });
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${company.ceo.token}`);
    const version = (await auth(app().get(`/api/v1/channel/shops/${shopId}`))).body.version;
    const res = await auth(app().post(`/api/v1/channel/shops/${shopId}/disconnect`)).send({ version, zeroStock: false });
    expect(res.status).toBe(200);
    expect(await schedules(shopId)).toEqual([]);
    expect(await boss.findJobs('platform.held', { data: { shopId } })).toHaveLength(0);
  });
});

describe('kéo đơn qua hàng việc (#102 AC-8)', () => {
  it('AC-8b: gian hàng active thì lượt kéo đơn gọi sàn', async () => {
    const { data } = await activeShop();
    await runOrderPull(data);
    expect(sàn.listOrders).toHaveBeenCalled();
  });

  it('AC-8b: gian hàng không còn active thì bỏ lịch, không gọi sàn', async () => {
    const { shopId, data } = await activeShop();
    await startShopJobs(data.companyId, shopId);
    await testPool().query(`update channel.shops set status = 'disconnected' where id = $1`, [shopId]);
    await runOrderPull(data);
    expect(sàn.listOrders).not.toHaveBeenCalled();
    expect(await schedules(shopId)).toEqual([]);
  });

  it('AC-8b: sàn từ chối token khi kéo đơn thì gian hàng needs_reauth, lịch dừng, việc được giữ', async () => {
    const { shopId, data } = await activeShop();
    await startShopJobs(data.companyId, shopId);
    sàn.ordersUnauthorized = true;
    await expect(runOrderPull(data)).rejects.toBeInstanceOf(HoldJob);
    expect(await shopStatus(shopId)).toMatchObject({ status: 'needs_reauth' });
    expect(await schedules(shopId)).toEqual([]);
  });

  it('#202: kéo yêu cầu trả lỗi tạm thì không làm hỏng lượt kéo đơn', async () => {
    const { data } = await activeShop();
    sàn.returnsError = new MarketplaceError('unavailable', 'SYSTEM', 'Sàn bận');
    await expect(runOrderPull(data)).resolves.toBeUndefined();
    expect(sàn.listOrders).toHaveBeenCalled();
    expect(sàn.listReturns).toHaveBeenCalled();
  });

  it('#202: kéo yêu cầu trả bị từ chối token thì vẫn needs_reauth như kéo đơn', async () => {
    const { shopId, data } = await activeShop();
    await startShopJobs(data.companyId, shopId);
    sàn.returnsError = new MarketplaceError('unauthorized', 'IllegalAccessToken', 'Invalid token');
    await expect(runOrderPull(data)).rejects.toBeInstanceOf(HoldJob);
    expect(await shopStatus(shopId)).toMatchObject({ status: 'needs_reauth' });
  });
});

describe('làm mới token Lazada (#102 AC-5)', () => {
  it('access còn dưới 48 giờ thì làm mới, lưu token và hạn mới (đọc lại DB)', async () => {
    const { shopId, data } = await activeShop({ refreshToken: 'ref-1' });
    await testPool().query(`update channel.shops set access_expires_at = now() + interval '1 hour' where id = $1`, [shopId]);
    sàn.refresh.mockClear();
    await runTokenRefresh(data);
    expect(sàn.refresh).toHaveBeenCalledWith('ref-1');
    const row = await shopStatus(shopId);
    expect(row.status).toBe('active');
    expect(row.access_expires_at.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * HOUR);
  });

  it('access còn trên 48 giờ thì không gọi sàn', async () => {
    const { shopId, data } = await activeShop({ refreshToken: 'ref-2' });
    await testPool().query(`update channel.shops set access_expires_at = now() + interval '3 days' where id = $1`, [shopId]);
    sàn.refresh.mockClear();
    await runTokenRefresh(data);
    expect(sàn.refresh).not.toHaveBeenCalled();
  });

  it('refresh token bị sàn từ chối (IllegalRefreshToken) thì gian hàng needs_reauth, lịch dừng', async () => {
    const { shopId, data } = await activeShop({ refreshToken: 'ref-3' });
    await startShopJobs(data.companyId, shopId);
    await testPool().query(`update channel.shops set access_expires_at = now() + interval '1 hour' where id = $1`, [shopId]);
    sàn.refresh.mockRejectedValueOnce(new MarketplaceError('unauthorized', 'IllegalRefreshToken', 'refresh token is invalid'));
    await runTokenRefresh(data);
    expect(await shopStatus(shopId)).toMatchObject({ status: 'needs_reauth' });
    expect(await schedules(shopId)).toEqual([]);
  });

  it('sàn lỗi tạm thì ném để pg-boss thử lại, gian hàng vẫn active', async () => {
    const { shopId, data } = await activeShop({ refreshToken: 'ref-4' });
    await testPool().query(`update channel.shops set access_expires_at = now() + interval '1 hour' where id = $1`, [shopId]);
    sàn.refresh.mockRejectedValueOnce(new MarketplaceError('unavailable', '6', 'busy'));
    await expect(runTokenRefresh(data)).rejects.toThrow();
    expect(await shopStatus(shopId)).toMatchObject({ status: 'active' });
  });
});
