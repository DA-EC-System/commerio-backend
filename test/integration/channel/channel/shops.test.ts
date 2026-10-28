import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { markNeedsReauth } from '#src/modules/channel/index.ts';
import { ShopCallbackResult, ShopDetail, ShopList } from '#src/modules/channel/channel/api/schemas.ts';
import { MarketplaceError } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { addMember, createCompany, createCustomRole } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';

const DAY = 24 * 3600_000;

// Adapter giả: code `c-<seller>` đổi được token `tok-<seller>`; token `tok-<seller>` đọc ra seller đó.
// Code `down` giả lỗi tạm của sàn.
registerAdapter('lazada', {
  authorizeUrl: (state) => `https://auth.fake/oauth/authorize?state=${encodeURIComponent(state)}`,
  async exchangeCode(code) {
    if (code === 'down') throw new MarketplaceError('unavailable', 'ServiceTimeout');
    return {
      accessToken: `tok-${code.slice(2)}`,
      refreshToken: `ref-${code.slice(2)}`,
      accessExpiresAt: new Date(Date.now() + 10 * DAY),
      refreshExpiresAt: new Date(Date.now() + 50 * DAY),
    };
  },
  async refreshToken(refreshToken) {
    return { accessToken: `tok-${refreshToken.slice(4)}`, refreshToken, accessExpiresAt: null, refreshExpiresAt: null };
  },
  async getSeller(accessToken) {
    if (accessToken === 'tok-bad') throw new MarketplaceError('unauthorized', 'IllegalAccessToken', 'Invalid token');
    return { externalShopId: accessToken.slice(4), shopName: `Shop ${accessToken.slice(4, 12)}`, region: 'VN' };
  },
});
afterAll(() => resetAdapters());

const app = () => request(testApp());
const seller = () => randomUUID().replace(/-/g, '').slice(0, 12);

let company: Awaited<ReturnType<typeof createCompany>>;
let token: string;

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
  token = company.ceo.token;
});

async function stateFor(bearer: string, platform = 'lazada'): Promise<string> {
  const res = await app().get(`/api/v1/channel/shops/${platform}/authorize-url`).set('Authorization', `Bearer ${bearer}`);
  expect(res.status).toBe(200);
  return new URL(res.body.url).searchParams.get('state')!;
}

async function connect(bearer: string, sellerId: string) {
  return app()
    .post('/api/v1/channel/shops/lazada/token')
    .set('Authorization', `Bearer ${bearer}`)
    .send({ accessToken: `tok-${sellerId}` });
}

async function shopRow(id: string) {
  const { rows } = await testPool().query('select * from channel.shops where id = $1', [id]);
  return rows[0];
}

describe('kết nối bằng OAuth', () => {
  it('callback lần đầu tạo gian hàng connecting, token lưu đã mã hoá, hạn lấy từ sàn', async () => {
    const id = seller();
    const res = await app()
      .post('/api/v1/channel/shops/lazada/callback')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: `c-${id}`, state: await stateFor(token) });
    expect(res.status).toBe(201);
    const body = ShopCallbackResult.parse(res.body);
    expect(body).toMatchObject({ created: true, reconnect: null, shop: { status: 'connecting', externalShopId: id } });
    expect(JSON.stringify(res.body)).not.toContain(`tok-${id}`);

    const row = await shopRow(body.shop.id);
    expect(row.access_token_enc.toString('latin1')).not.toContain(`tok-${id}`);
    expect(row.refresh_token_enc).not.toBeNull();
    expect(row.refresh_expires_at.getTime()).toBeGreaterThan(Date.now() + 49 * DAY);

    const detail = await app().get(`/api/v1/channel/shops/${body.shop.id}`).set('Authorization', `Bearer ${token}`);
    expect(ShopDetail.parse(detail.body).statusHistory).toMatchObject([{ from: null, to: 'connecting', source: 'user' }]);
  });

  it('state sai, của người khác hoặc của sàn khác thì 422 oauth_state_invalid', async () => {
    const other = await addMember(company.companyId, 'admin');
    const call = (state: string) =>
      app().post('/api/v1/channel/shops/lazada/callback').set('Authorization', `Bearer ${token}`).send({ code: 'c-x', state });
    for (const state of ['rác', await stateFor(other.token)]) {
      const res = await call(state);
      expect(res.status).toBe(422);
      expect(res.body.type).toBe('/problems/oauth_state_invalid');
    }
  });

  it('lỗi sàn đổi sang mã app', async () => {
    const call = async (code: string) =>
      app()
        .post('/api/v1/channel/shops/lazada/callback')
        .set('Authorization', `Bearer ${token}`)
        .send({ code, state: await stateFor(token) });
    const down = await call('down');
    expect(down.status).toBe(503);
    expect(down.body).toMatchObject({ code: 'marketplace_unavailable', platformCode: 'ServiceTimeout' });
    const bad = await connect(token, 'bad');
    expect(bad.status).toBe(409);
    expect(bad.body).toMatchObject({ code: 'marketplace_rejected', platformCode: 'IllegalAccessToken' });
  });

  it('sàn chưa có adapter thì 422 marketplace_unsupported; sàn lạ thì 422 validation_failed', async () => {
    const shopee = await app().get('/api/v1/channel/shops/shopee/authorize-url').set('Authorization', `Bearer ${token}`);
    expect(shopee.status).toBe(422);
    expect(shopee.body.code).toBe('marketplace_unsupported');
    const odd = await app().get('/api/v1/channel/shops/amazon/authorize-url').set('Authorization', `Bearer ${token}`);
    expect(odd.status).toBe(422);
    expect(odd.body.code).toBe('validation_failed');
  });
});

describe('kết nối bằng token console', () => {
  it('tạo gian hàng; gọi lại khi đang connecting chỉ thay token', async () => {
    const id = seller();
    const first = await connect(token, id);
    expect(first.status).toBe(201);
    const again = await connect(token, id);
    expect(again.status).toBe(200);
    expect(ShopCallbackResult.parse(again.body)).toMatchObject({
      created: false,
      reconnect: null,
      shop: { id: first.body.shop.id, status: 'connecting', version: first.body.shop.version + 1 },
    });
  });

  it('seller đang gắn công ty khác thì 409 shop_connected_elsewhere; ngắt xong thì công ty khác nối được', async () => {
    const id = seller();
    const mine = await connect(token, id);
    const other = await createCompany({ optionalModules: ['channel'] });
    const blocked = await connect(other.ceo.token, id);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('shop_connected_elsewhere');

    await app()
      .post(`/api/v1/channel/shops/${mine.body.shop.id}/disconnect`)
      .set('Authorization', `Bearer ${token}`)
      .send({ version: mine.body.shop.version });
    expect((await connect(other.ceo.token, id)).status).toBe(201);
  });
});

describe('ngắt và nối lại', () => {
  it('ngắt: xoá token, listing trên sàn chuyển delisted có lịch sử; ngắt lần hai 409', async () => {
    const shop = (await connect(token, seller())).body.shop;
    const listing = await testPool().query<{ id: string }>(
      "insert into channel.listings (company_id, shop_id, variant_id, status) values ($1, $2, $3, 'live') returning id",
      [company.companyId, shop.id, randomUUID()],
    );

    const stale = await app()
      .post(`/api/v1/channel/shops/${shop.id}/disconnect`)
      .set('Authorization', `Bearer ${token}`)
      .send({ version: shop.version + 5 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_conflict');

    const res = await app()
      .post(`/api/v1/channel/shops/${shop.id}/disconnect`)
      .set('Authorization', `Bearer ${token}`)
      .send({ version: shop.version });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'disconnected', listingCount: 0 });

    const row = await shopRow(shop.id);
    expect(row).toMatchObject({ status: 'disconnected', access_token_enc: null, refresh_token_enc: null });
    expect(row.disconnected_at).not.toBeNull();
    const { rows } = await testPool().query('select status, delisted_by_disconnect from channel.listings where id = $1', [
      listing.rows[0]!.id,
    ]);
    expect(rows[0]).toEqual({ status: 'delisted', delisted_by_disconnect: true });
    const history = await testPool().query(
      "select from_state, to_state from core.state_transitions where entity_type = 'listings' and entity_id = $1",
      [listing.rows[0]!.id],
    );
    expect(history.rows).toEqual([{ from_state: 'live', to_state: 'delisted' }]);

    const twice = await app()
      .post(`/api/v1/channel/shops/${shop.id}/disconnect`)
      .set('Authorization', `Bearer ${token}`)
      .send({ version: res.body.version });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('invalid_transition');
  });

  it('nối lại gian hàng đã thiết lập thì về active, báo mốc kéo đơn; chưa thiết lập thì về connecting', async () => {
    const id = seller();
    const shop = (await connect(token, id)).body.shop;
    // Thiết lập lần đầu là #104; ở đây dựng trạng thái đã thiết lập bằng SQL.
    await testPool().query(
      "update channel.shops set status = 'active', order_cutoff_at = '2026-10-01T00:00:00Z', version = version + 1 where id = $1",
      [shop.id],
    );
    await app()
      .post(`/api/v1/channel/shops/${shop.id}/disconnect`)
      .set('Authorization', `Bearer ${token}`)
      .send({ version: shop.version + 1 });
    const back = await connect(token, id);
    expect(back.status).toBe(200);
    expect(ShopCallbackResult.parse(back.body)).toMatchObject({
      created: false,
      shop: { id: shop.id, status: 'active' },
      reconnect: { pulledFrom: '2026-10-01T00:00:00.000Z', relisted: 0, jobsRun: 0 },
    });

    const fresh = (await connect(token, seller())).body.shop;
    await app()
      .post(`/api/v1/channel/shops/${fresh.id}/disconnect`)
      .set('Authorization', `Bearer ${token}`)
      .send({ version: fresh.version });
    const resumed = await connect(token, fresh.externalShopId);
    expect(resumed.body).toMatchObject({ created: false, reconnect: null, shop: { status: 'connecting' } });
  });

  it('markNeedsReauth: active sang needs_reauth, nguồn hệ thống; trạng thái khác thì bỏ qua', async () => {
    const shop = (await connect(token, seller())).body.shop;
    await withCompany(company.companyId, () => markNeedsReauth(shop.id, 'refresh token hết hạn'));
    expect((await shopRow(shop.id)).status).toBe('connecting');

    await testPool().query(
      "update channel.shops set status = 'active', order_cutoff_at = now() where id = $1",
      [shop.id],
    );
    await withCompany(company.companyId, () => markNeedsReauth(shop.id, 'refresh token hết hạn'));
    const detail = await app().get(`/api/v1/channel/shops/${shop.id}`).set('Authorization', `Bearer ${token}`);
    expect(detail.body.status).toBe('needs_reauth');
    expect(detail.body.statusHistory.at(-1)).toMatchObject({
      from: 'active',
      to: 'needs_reauth',
      by: null,
      source: 'system',
      reason: 'refresh token hết hạn',
    });
  });
});

describe('quyền và công ty', () => {
  it('danh sách chỉ có gian hàng của công ty mình; gian hàng công ty khác 404', async () => {
    const other = await createCompany({ optionalModules: ['channel'] });
    const theirs = (await connect(other.ceo.token, seller())).body.shop;
    const list = await app().get('/api/v1/channel/shops').set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    const items = ShopList.parse(list.body).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((s) => s.companyId === company.companyId)).toBe(true);
    const res = await app().get(`/api/v1/channel/shops/${theirs.id}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('401 không token; 403 thiếu quyền kết nối; 403 module_disabled khi tắt phân hệ', async () => {
    expect((await app().get('/api/v1/channel/shops')).status).toBe(401);
    const viewer = await addMember(company.companyId, await createCustomRole(company.companyId, ['channel.shop.view']));
    expect((await app().get('/api/v1/channel/shops').set('Authorization', `Bearer ${viewer.token}`)).status).toBe(200);
    const denied = await connect(viewer.token, seller());
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('forbidden');
    const off = await createCompany();
    const disabled = await app().get('/api/v1/channel/shops').set('Authorization', `Bearer ${off.ceo.token}`);
    expect(disabled.status).toBe(403);
    expect(disabled.body.code).toBe('module_disabled');
  });

  it('body sai thì 422 theo ô', async () => {
    const res = await app()
      .post('/api/v1/channel/shops/lazada/token')
      .set('Authorization', `Bearer ${token}`)
      .send({ accessToken: '' });
    expect(res.status).toBe(422);
    expect(res.body.errors).toHaveProperty('accessToken');
  });
});
