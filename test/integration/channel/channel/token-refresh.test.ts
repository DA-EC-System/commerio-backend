import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { jobBoss, stopJobs } from '#src/modules/core/platform/service/jobs/boss.ts';
import { runTokenRefresh } from '#src/modules/channel/channel/service/background.ts';
import { MarketplaceError, type TokenSet } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { orderPullQueue } from '#src/modules/channel/channel/service/shop-jobs.ts';
import { refreshShopToken } from '#src/modules/channel/channel/service/shop-tokens.ts';
import { shopSession } from '#src/modules/channel/channel/service/shops.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { fakeAdapter } from './helpers.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Sàn giả kiểu Shopee (#201): access sống 4 giờ, refresh token dùng một lần (gọi lại với token đã tiêu thì `unauthorized`).
 * Khai `refreshDueAt` 1 giờ trước hạn access. `slowMs` giữ lời gọi làm mới để hai lần làm mới chạy chồng nhau.
 */
const sàn = {
  slowMs: 0,
  /** false: sàn cấp token mới nhưng vẫn từ chối nó (seller gỡ app). */
  acceptNew: true,
  /** Sàn từ chối mọi refresh token (hết hạn, bị thu hồi). */
  rejectRefresh: false,
  used: new Set<string>(),
  refresh: vi.fn(),
  /** Access token sàn còn nhận; token khác ném `unauthorized`. */
  valid: new Set<string>(),
  listSkus: vi.fn(),
};
let seq = 0;
registerAdapter(
  'shopee',
  fakeAdapter({
    refreshDueAt: (t) => (t.accessExpiresAt ? new Date(t.accessExpiresAt.getTime() - HOUR) : null),
    async refreshToken(refreshToken): Promise<TokenSet> {
      sàn.refresh(refreshToken);
      if (sàn.slowMs) await new Promise((r) => setTimeout(r, sàn.slowMs));
      if (sàn.rejectRefresh || sàn.used.has(refreshToken)) throw new MarketplaceError('unauthorized', 'invalid_refresh_token', 'đã dùng');
      sàn.used.add(refreshToken);
      const n = ++seq;
      const seller = refreshToken.split(':')[0]!;
      if (sàn.acceptNew) sàn.valid.add(`${seller}:acc-${n}`);
      return {
        accessToken: `${seller}:acc-${n}`,
        refreshToken: `${seller}:ref-${n}`,
        accessExpiresAt: new Date(Date.now() + 4 * HOUR),
        refreshExpiresAt: new Date(Date.now() + 30 * DAY),
      };
    },
    async getSeller(accessToken) {
      return { externalShopId: accessToken.split(':')[0]!, shopName: 'Shop 4 giờ', region: 'VN' };
    },
    async listSkus(accessToken) {
      sàn.listSkus(accessToken);
      if (!sàn.valid.has(accessToken)) throw new MarketplaceError('unauthorized', 'invalid_access_token', 'hết hạn');
      return [];
    },
  }),
);
afterAll(async () => {
  resetAdapters();
  await stopJobs();
});
beforeEach(() => {
  sàn.slowMs = 0;
  sàn.acceptNew = true;
  sàn.rejectRefresh = false;
  sàn.refresh.mockClear();
  sàn.listSkus.mockClear();
});

const app = () => request(testApp());

/** Gian hàng `active` vừa nối (connectWithToken làm mới một lần): access hạn 4 giờ, refresh token chưa tiêu. */
async function activeShop() {
  const company = await createCompany({ optionalModules: ['channel'] });
  const seller = randomUUID().replace(/-/g, '').slice(0, 12);
  sàn.valid.add(`${seller}:acc-0`);
  const res = await app()
    .post('/api/v1/channel/shops/shopee/token')
    .set('Authorization', `Bearer ${company.ceo.token}`)
    .send({ accessToken: `${seller}:acc-0`, refreshToken: `${seller}:ref-0` });
  expect(res.status).toBe(201);
  const shopId: string = res.body.shop.id;
  await testPool().query(`update channel.shops set status = 'active', order_cutoff_at = now() where id = $1`, [shopId]);
  sàn.refresh.mockClear();
  return { company, shopId, seller, companyId: company.companyId };
}

const setExpiry = (shopId: string, sql: string) => testPool().query(`update channel.shops set ${sql} where id = $1`, [shopId]);
const shopRow = async (id: string) =>
  (await testPool().query('select status, access_expires_at, version from channel.shops where id = $1', [id])).rows[0];

describe('làm mới token theo ngưỡng adapter khai (#201)', () => {
  it('access 4 giờ vừa làm mới thì vòng việc nền sau không làm mới lại', async () => {
    const { shopId, companyId } = await activeShop();
    expect(await refreshShopToken(companyId, shopId)).toBe('skipped');
    expect(sàn.refresh).not.toHaveBeenCalled();
  });

  it('tới refreshDueAt (còn dưới 1 giờ) thì làm mới đúng một lần, vòng ngay sau bỏ qua', async () => {
    const { shopId, companyId } = await activeShop();
    await setExpiry(shopId, `access_expires_at = now() + interval '30 minutes'`);
    const before = await shopRow(shopId);
    expect(await refreshShopToken(companyId, shopId)).toBe('refreshed');
    expect(await refreshShopToken(companyId, shopId)).toBe('skipped');
    expect(sàn.refresh).toHaveBeenCalledTimes(1);
    const after = await shopRow(shopId);
    expect(after.access_expires_at.getTime()).toBeGreaterThan(Date.now() + 3 * HOUR);
    // Token do việc nền đổi không tăng `version`: thao tác người dùng đang mở không bị 409 vô cớ.
    expect(after.version).toBe(before.version);
  });

  it('hai lần làm mới song song chỉ gọi sàn một lần, refresh token dùng một lần không bị tiêu hai lần', async () => {
    const { shopId, companyId } = await activeShop();
    await setExpiry(shopId, `access_expires_at = now() + interval '10 minutes'`);
    sàn.slowMs = 300;
    const results = await Promise.all([refreshShopToken(companyId, shopId), refreshShopToken(companyId, shopId)]);
    expect(results.sort()).toEqual(['refreshed', 'skipped']);
    expect(sàn.refresh).toHaveBeenCalledTimes(1);
    expect(await shopRow(shopId)).toMatchObject({ status: 'active' });
  });

  it('tới hạn uỷ quyền mà chưa kết nối lại thì lose_auth sang needs_reauth, không gọi sàn (US-GH-12 dòng 2)', async () => {
    const { shopId, companyId } = await activeShop();
    await setExpiry(shopId, `auth_expires_at = now() - interval '1 minute', access_expires_at = now() + interval '10 minutes'`);
    await runTokenRefresh({ companyId, shopId });
    expect(await shopRow(shopId)).toMatchObject({ status: 'needs_reauth' });
    expect(sàn.refresh).not.toHaveBeenCalled();
    const history = await testPool().query(
      `select action, actor_id from core.state_transitions where entity_type = 'shops' and entity_id = $1 and action = 'lose_auth'`,
      [shopId],
    );
    expect(history.rows).toEqual([{ action: 'lose_auth', actor_id: null }]);
  });

  it('refresh token hết hạn (refreshExpiresAt đã qua) cũng là tới hạn uỷ quyền', async () => {
    const { shopId, companyId } = await activeShop();
    await setExpiry(shopId, `refresh_expires_at = now() - interval '1 minute'`);
    expect(await refreshShopToken(companyId, shopId)).toBe('lost');
    expect(await shopRow(shopId)).toMatchObject({ status: 'needs_reauth' });
  });
});

describe('lớp bọc adapter: unauthorized thì làm mới một lần rồi gọi lại (Documents/16 bài toán 3)', () => {
  const session = (companyId: string, shopId: string) => withCompany(companyId, () => shopSession(shopId));

  it('access bị sàn từ chối thì làm mới, gọi lại với token mới; lần sau trong phiên dùng luôn token mới', async () => {
    const { shopId, companyId, seller } = await activeShop();
    const { adapter, accessToken } = await session(companyId, shopId);
    sàn.valid.delete(accessToken);
    await expect(adapter.listSkus!(accessToken)).resolves.toEqual([]);
    expect(sàn.refresh).toHaveBeenCalledTimes(1);
    expect(sàn.listSkus.mock.calls.map((c) => c[0])).toEqual([accessToken, expect.stringMatching(new RegExp(`^${seller}:acc-`))]);
    sàn.listSkus.mockClear();
    await adapter.listSkus!(accessToken);
    expect(sàn.listSkus).toHaveBeenCalledTimes(1);
    expect(sàn.listSkus.mock.calls[0]![0]).not.toBe(accessToken);
    expect(sàn.refresh).toHaveBeenCalledTimes(1);
  });

  it('hai lời gọi song song cùng bị từ chối chỉ làm mới một lần, cả hai gọi lại thành công', async () => {
    const { shopId, companyId } = await activeShop();
    const a = await session(companyId, shopId);
    const b = await session(companyId, shopId);
    sàn.valid.delete(a.accessToken);
    sàn.slowMs = 200;
    await expect(Promise.all([a.adapter.listSkus!(a.accessToken), b.adapter.listSkus!(b.accessToken)])).resolves.toEqual([[], []]);
    expect(sàn.refresh).toHaveBeenCalledTimes(1);
  });

  it('gọi lại vẫn unauthorized thì ném lỗi của sàn, chỉ làm mới một lần', async () => {
    const { shopId, companyId } = await activeShop();
    const { adapter, accessToken } = await session(companyId, shopId);
    sàn.valid.delete(accessToken);
    sàn.acceptNew = false;
    await expect(adapter.listSkus!(accessToken)).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(sàn.refresh).toHaveBeenCalledTimes(1);
  });

  it('refresh token bị sàn từ chối thì gian hàng needs_reauth và lời gọi ném unauthorized', async () => {
    const { shopId, companyId } = await activeShop();
    const { adapter, accessToken } = await session(companyId, shopId);
    sàn.valid.delete(accessToken);
    sàn.rejectRefresh = true;
    await expect(adapter.listSkus!(accessToken)).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(await shopRow(shopId)).toMatchObject({ status: 'needs_reauth' });
  });

  it('lỗi khác unauthorized thì không làm mới', async () => {
    const { shopId, companyId } = await activeShop();
    const { adapter, accessToken } = await session(companyId, shopId);
    await expect(adapter.getSkus(accessToken, ['X'])).rejects.toMatchObject({ kind: 'unsupported' });
    expect(sàn.refresh).not.toHaveBeenCalled();
  });
});

describe('Shop trả authExpiresAt, nhãn Sắp hết hạn theo hạn gần hơn (21 §18.4, US-GH-12 dòng 1)', () => {
  it('hạn uỷ quyền còn 2 ngày dù refresh token còn 30 ngày thì tokenExpiringSoon', async () => {
    const { company, shopId } = await activeShop();
    await setExpiry(shopId, `auth_expires_at = now() + interval '2 days'`);
    const res = await app().get(`/api/v1/channel/shops/${shopId}`).set('Authorization', `Bearer ${company.ceo.token}`);
    expect(res.status).toBe(200);
    expect(res.body.tokenExpiringSoon).toBe(true);
    expect(Date.parse(res.body.authExpiresAt)).toBeLessThan(Date.now() + 3 * DAY);
  });

  it('không có hạn uỷ quyền thì authExpiresAt null, nhãn theo refreshExpiresAt', async () => {
    const { company, shopId } = await activeShop();
    const res = await app().get(`/api/v1/channel/shops/${shopId}`).set('Authorization', `Bearer ${company.ceo.token}`);
    expect(res.body).toMatchObject({ authExpiresAt: null, tokenExpiringSoon: false });
  });
});

describe('kết nối lại gian hàng đã thiết lập (US-GH-14 dòng 1)', () => {
  it('needs_reauth nối lại về active, dùng lại bản ghi, xếp ngay một lượt kéo đơn', async () => {
    const { company, shopId, seller } = await activeShop();
    await testPool().query(`update channel.shops set status = 'needs_reauth' where id = $1`, [shopId]);
    sàn.valid.add(`${seller}:acc-x`);
    const res = await app()
      .post('/api/v1/channel/shops/shopee/token')
      .set('Authorization', `Bearer ${company.ceo.token}`)
      .send({ accessToken: `${seller}:acc-x` });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: false, shop: { id: shopId, status: 'active' }, reconnect: { relisted: 0 } });
    const boss = await jobBoss();
    expect(await boss.findJobs(orderPullQueue.name, { data: { shopId } })).not.toHaveLength(0);
  });
});
