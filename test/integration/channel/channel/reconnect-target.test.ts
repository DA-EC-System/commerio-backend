// Nối lại đúng gian hàng (#398 phần 2; Documents/21 §18.4 dòng `authorize-url`, mã lỗi `shop_mismatch`, §18.7.4).
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MarketplaceError } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { shopSession } from '#src/modules/channel/channel/service/shops.ts';
import { verifyPurposeToken } from '#src/shared/auth/purpose-token.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { activateShop, fakeAdapter } from './helpers.ts';

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

/** Mọi dòng gian hàng của công ty và số dòng nhật ký: ca lỗi so trước, sau phải bằng nhau (kể cả token mã hoá, `version`). */
async function snapshot(companyId: string) {
  const shops = await testPool().query('select * from channel.shops where company_id = $1 order by id', [companyId]);
  const audits = await testPool().query<{ n: number }>('select count(*)::int as n from core.audit_logs where company_id = $1', [
    companyId,
  ]);
  return { shops: shops.rows, audits: audits.rows[0]!.n };
}

async function shopOf(id: string) {
  const { rows } = await testPool().query('select * from channel.shops where id = $1', [id]);
  return rows[0];
}

async function disconnectedShop(bearer: string, sellerId = seller()): Promise<string> {
  const id = await newShop(bearer, sellerId);
  await testPool().query(
    "update channel.shops set status = 'disconnected', disconnected_at = now(), access_token_enc = null, refresh_token_enc = null where id = $1",
    [id],
  );
  return id;
}

describe('callback nối lại theo shopId trong state (#398)', () => {
  it('sàn trả seller chưa có trong công ty thì 409 shop_mismatch, actual.name null, không ghi gì', async () => {
    const [a, b] = [seller(), seller()];
    const shopId = await disconnectedShop(token, a);
    const before = await snapshot(company.companyId);
    const res = await connectOAuth(token, [b], shopId);
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/shop_mismatch');
    expect(res.body.expected).toEqual({ name: `Shop ${a.slice(0, 8)}`, externalShopId: a });
    expect(res.body.actual).toEqual({ name: null, externalShopId: b });
    expect(JSON.stringify(res.body)).not.toContain('tok-');
    expect(await snapshot(company.companyId)).toEqual(before);
    expect((await shopOf(shopId)).status).toBe('disconnected');
  });

  it('sàn trả seller đã có trong công ty thì 409, actual.name là tên gian hàng đó, gian hàng đó giữ token cũ', async () => {
    const [a, b] = [seller(), seller()];
    const shopId = await disconnectedShop(token, a);
    await activateShop(await newShop(token, b));
    const before = await snapshot(company.companyId);
    const res = await connectOAuth(token, [b], shopId);
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/shop_mismatch');
    expect(res.body.expected).toEqual({ name: `Shop ${a.slice(0, 8)}`, externalShopId: a });
    expect(res.body.actual).toEqual({ name: `Shop ${b.slice(0, 8)}`, externalShopId: b });
    expect(await snapshot(company.companyId)).toEqual(before);
  });

  it('sàn trả seller đang gắn công ty khác thì 409 shop_mismatch (không phải shop_connected_elsewhere), actual.name null', async () => {
    const [a, b] = [seller(), seller()];
    const other = await createCompany({ optionalModules: ['channel'] });
    await newShop(other.ceo.token, b);
    const shopId = await disconnectedShop(token, a);
    const before = await snapshot(company.companyId);
    const otherBefore = await snapshot(other.companyId);
    const res = await connectOAuth(token, [b], shopId);
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/shop_mismatch');
    expect(res.body.actual).toEqual({ name: null, externalShopId: b });
    expect(await snapshot(company.companyId)).toEqual(before);
    expect(await snapshot(other.companyId)).toEqual(otherBefore);
  });

  it('một lần uỷ quyền ra nhiều gian hàng có gian hàng đích thì nối tất cả', async () => {
    const [a, b] = [seller(), seller()];
    const shopId = await disconnectedShop(token, a);
    const res = await connectOAuth(token, [a, b], shopId);
    expect(res.status).toBe(201);
    expect(res.body.shops.map((r: { shop: { externalShopId: string } }) => r.shop.externalShopId)).toEqual([a, b]);
    expect(res.body.shops[0].shop.id).toBe(shopId);
  });

  it('gian hàng trong state bị xoá trước callback thì 404 not_found, chưa đổi mã', async () => {
    const a = seller();
    const shopId = await newShop(token, a);
    const state = await stateFor(token, 'lazada', shopId);
    await testPool().query('delete from channel.shops where id = $1', [shopId]);
    const exchanges = sàn.exchanges;
    const res = await app()
      .post('/api/v1/channel/shops/lazada/callback')
      .set('Authorization', `Bearer ${token}`)
      .send({ state, params: { code: `c-${a}` } });
    expect(res.status).toBe(404);
    expect(res.body.type).toBe('/problems/not_found');
    expect(sàn.exchanges).toBe(exchanges);
    expect(await testPool().query('select 1 from channel.shops where external_shop_id = $1', [a])).toMatchObject({ rowCount: 0 });
  });

  it('sàn trả đúng seller của gian hàng đích thì nối lại gian hàng đó', async () => {
    const a = seller();
    const shopId = await disconnectedShop(token, a);
    const res = await connectOAuth(token, [a], shopId);
    expect(res.status).toBe(200);
    expect(res.body.shop.id).toBe(shopId);
  });
});

/** Gian hàng Lazada đã thiết lập (`active`), rồi đưa về `status`: `needs_reauth` bằng SQL, `disconnected` bằng API ngắt. */
async function shopIn(status: 'active' | 'needs_reauth' | 'disconnected', sellerId: string) {
  const shopId = await newShop(token, sellerId);
  await activateShop(shopId);
  const expiresAt: Date = (await shopOf(shopId)).access_expires_at;
  if (status === 'needs_reauth') {
    await testPool().query("update channel.shops set status = 'needs_reauth' where id = $1", [shopId]);
  } else if (status === 'disconnected') {
    const { version } = await shopOf(shopId);
    const res = await app()
      .post(`/api/v1/channel/shops/${shopId}/disconnect`)
      .set('Authorization', `Bearer ${token}`)
      .send({ version, zeroStock: false });
    expect(res.status).toBe(200);
  }
  return { shopId, expiresAt };
}

describe('nối lại qua callback lưu token mới (#398 AC 1)', () => {
  it.each(['needs_reauth', 'disconnected'] as const)('gian hàng %s nối lại đúng seller thì active, lưu token và hạn của lần đổi mã', async (status) => {
    const a = seller();
    const { shopId, expiresAt } = await shopIn(status, a);
    const res = await connectOAuth(token, [a], shopId);
    expect(res.status).toBe(200);
    expect(res.body.shop).toMatchObject({ id: shopId, status: 'active' });
    expect(res.body.reconnect).not.toBeNull();
    const session = await withCompany(company.companyId, () => shopSession(shopId));
    expect(session.accessToken).toBe(`tok-${a}-${sàn.exchanges}`);
    expect((await shopOf(shopId)).access_expires_at.getTime()).toBeGreaterThan(expiresAt.getTime());
  });
});

async function shopAudits(shopId: string) {
  const { rows } = await testPool().query(
    "select action, actor_id, before, after from core.audit_logs where entity_type = 'channel.shops' and entity_id = $1 order by created_at",
    [shopId],
  );
  return rows;
}

describe('nhật ký nối lại (#398 AC 4)', () => {
  it.each(['active', 'needs_reauth'] as const)('nối lại gian hàng %s qua callback ghi đúng một dòng update, không có token', async (status) => {
    const a = seller();
    const { shopId } = await shopIn(status, a);
    const actorId = (await verifyPurposeToken('oauth', await stateFor(token, 'lazada'))).sub;
    expect(await shopAudits(shopId)).toHaveLength(0);
    const res = await connectOAuth(token, [a], shopId);
    expect(res.status).toBe(200);
    const audits = await shopAudits(shopId);
    expect(audits).toHaveLength(1);
    const [row] = audits;
    expect(row).toMatchObject({ action: 'update', actor_id: actorId, before: { status }, after: { status: 'active', connectedVia: 'oauth' } });
    expect(row.after.accessExpiresAt).not.toEqual(row.before.accessExpiresAt);
    expect(JSON.stringify(row.before) + JSON.stringify(row.after)).not.toContain('tok-');
  });

  it('nối lại bằng token dán từ console ghi connectedVia token', async () => {
    const id = seller();
    const connect = () =>
      app().post('/api/v1/channel/shops/tiktok/token').set('Authorization', `Bearer ${token}`).send({ accessToken: `tok-${id}` });
    const first = await connect();
    expect(first.status).toBe(201);
    expect((await connect()).status).toBe(200);
    expect(await shopAudits(first.body.shop.id)).toMatchObject([{ action: 'update', after: { connectedVia: 'token' } }]);
  });

  it('tạo gian hàng mới qua callback không ghi nhật ký channel.shops', async () => {
    const shopId = await newShop(token);
    expect(await shopAudits(shopId)).toHaveLength(0);
  });
});
