// Nối lại đúng gian hàng (#398 phần 2; Documents/21 §18.4 dòng `authorize-url`, mã lỗi `shop_mismatch`, §18.7.4).
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MarketplaceError } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { verifyPurposeToken } from '#src/shared/auth/purpose-token.ts';
import { createCompany } from '../../helpers/company.ts';
import { testApp } from '../../helpers/http.ts';
import { fakeAdapter } from './helpers.ts';

const DAY = 24 * 3600_000;
const MINUTE = 60_000;

// Sàn giả: code `c-<seller>` (hoặc `c-<a>+<b>`: một lần uỷ quyền ra nhiều gian hàng). Mỗi lần đổi mã cấp token mới
// `tok-<seller>-<n>`, hạn truy cập dời thêm n phút, để test phân biệt token của lần nối nào đã được lưu.
const sàn = { exchanges: 0 };
registerAdapter('lazada', fakeAdapter({
  authorizeUrl: (state) => `https://auth.fake/oauth/authorize?state=${encodeURIComponent(state)}`,
  async exchangeCode({ code }) {
    if (!code?.startsWith('c-')) throw new MarketplaceError('rejected', 'missing_parameter');
    const n = ++sàn.exchanges;
    return code
      .slice(2)
      .split('+')
      .map((id) => ({
        externalShopId: id,
        shopName: `Shop ${id.slice(0, 8)}`,
        region: 'VN',
        tokens: {
          accessToken: `tok-${id}-${n}`,
          refreshToken: `ref-${id}-${n}`,
          accessExpiresAt: new Date(Date.now() + 10 * DAY + n * MINUTE),
          refreshExpiresAt: new Date(Date.now() + 50 * DAY),
        },
      }));
  },
}));
// TikTok giả chỉ để có gian hàng thuộc sàn khác, nối bằng token (`tok-<seller>`).
registerAdapter('tiktok', fakeAdapter({
  async getSeller(accessToken) {
    const id = accessToken.slice(4);
    return { externalShopId: id, shopName: `TikTok ${id.slice(0, 8)}`, region: 'VN' };
  },
}));
afterAll(() => resetAdapters());

const app = () => request(testApp());
const seller = () => randomUUID().replace(/-/g, '').slice(0, 12);

let company: Awaited<ReturnType<typeof createCompany>>;
let token: string;

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
  token = company.ceo.token;
});

function authorizeUrl(bearer: string, platform: string, query = '') {
  return app().get(`/api/v1/channel/shops/${platform}/authorize-url${query}`).set('Authorization', `Bearer ${bearer}`);
}

async function stateFor(bearer: string, platform: string, shopId?: string): Promise<string> {
  const res = await authorizeUrl(bearer, platform, shopId ? `?shopId=${encodeURIComponent(shopId)}` : '');
  expect(res.status).toBe(200);
  return new URL(res.body.url).searchParams.get('state')!;
}

async function connectOAuth(bearer: string, sellers: string[], shopId?: string) {
  const state = await stateFor(bearer, 'lazada', shopId);
  return app()
    .post('/api/v1/channel/shops/lazada/callback')
    .set('Authorization', `Bearer ${bearer}`)
    .send({ state, params: { code: `c-${sellers.join('+')}` } });
}

/** Gian hàng Lazada mới của công ty `bearer`, trả id. */
async function newShop(bearer: string, sellerId = seller()): Promise<string> {
  const res = await connectOAuth(bearer, [sellerId]);
  expect(res.status).toBe(201);
  return res.body.shop.id;
}

describe('authorize-url nhận shopId (#398, 21 §18.4)', () => {
  it('shopId của gian hàng mình cùng sàn thì state mang shp; không gửi thì shp vắng', async () => {
    const shopId = await newShop(token);
    expect((await verifyPurposeToken('oauth', await stateFor(token, 'lazada', shopId))).shp).toBe(shopId);
    expect((await verifyPurposeToken('oauth', await stateFor(token, 'lazada'))).shp).toBeUndefined();
  });

  it('gian hàng của công ty khác thì 404 not_found', async () => {
    const other = await createCompany({ optionalModules: ['channel'] });
    const foreign = await newShop(other.ceo.token);
    const res = await authorizeUrl(token, 'lazada', `?shopId=${foreign}`);
    expect(res.status).toBe(404);
    expect(res.body.type).toBe('/problems/not_found');
  });

  it('gian hàng thuộc sàn khác sàn trên URL thì 404 not_found', async () => {
    const tiktok = await app()
      .post('/api/v1/channel/shops/tiktok/token')
      .set('Authorization', `Bearer ${token}`)
      .send({ accessToken: `tok-${seller()}` });
    expect(tiktok.status).toBe(201);
    const res = await authorizeUrl(token, 'lazada', `?shopId=${tiktok.body.shop.id}`);
    expect(res.status).toBe(404);
    expect(res.body.type).toBe('/problems/not_found');
  });

  it('shopId không phải uuid thì 404 not_found', async () => {
    const res = await authorizeUrl(token, 'lazada', '?shopId=abc');
    expect(res.status).toBe(404);
    expect(res.body.type).toBe('/problems/not_found');
  });

  it('shopId gửi hai lần thì 422 validation_failed errors.shopId', async () => {
    const shopId = await newShop(token);
    const res = await authorizeUrl(token, 'lazada', `?shopId=${shopId}&shopId=${shopId}`);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
    expect(res.body.errors).toHaveProperty('shopId');
  });
});
