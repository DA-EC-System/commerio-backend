import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { markNeedsReauth } from '#src/modules/channel/index.ts';
import { ShopCallbackResult, ShopDetail, ShopList } from '#src/modules/channel/channel/api/schemas.ts';
import { MarketplaceError } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { signPurposeToken } from '#src/shared/auth/purpose-token.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { addMember, createCompany, createCustomRole } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { fakeAdapter } from './helpers.ts';

const DAY = 24 * 3600_000;

// Adapter giả: code `c-<seller>` (hoặc `c-<a>+<b>`: một lần uỷ quyền ra nhiều gian hàng) đổi được token `tok-<seller>`;
// token `tok-<seller>` đọc ra seller đó. Code `down` giả lỗi tạm của sàn, `none` là uỷ quyền không có gian hàng nào.
const tokensOf = (id: string) => ({
  accessToken: `tok-${id}`,
  refreshToken: `ref-${id}`,
  accessExpiresAt: new Date(Date.now() + 10 * DAY),
  refreshExpiresAt: new Date(Date.now() + 50 * DAY),
});
registerAdapter('lazada', fakeAdapter({
  authorizeUrl: (state) => `https://auth.fake/oauth/authorize?state=${encodeURIComponent(state)}`,
  async exchangeCode(params) {
    const code = params.code;
    if (!code) throw new MarketplaceError('rejected', 'missing_parameter');
    if (code === 'down') throw new MarketplaceError('unavailable', 'ServiceTimeout');
    if (code === 'none') return [];
    return code
      .slice(2)
      .split('+')
      .map((id) => ({ externalShopId: id, shopName: `Shop ${id.slice(0, 8)}`, region: 'VN', tokens: tokensOf(id) }));
  },
  async refreshToken(refreshToken) {
    return { accessToken: `tok-${refreshToken.slice(4)}`, refreshToken, accessExpiresAt: null, refreshExpiresAt: null };
  },
  async getSeller(accessToken) {
    if (accessToken === 'tok-bad') throw new MarketplaceError('unauthorized', 'IllegalAccessToken', 'Invalid token');
    return { externalShopId: accessToken.slice(4), shopName: `Shop ${accessToken.slice(4, 12)}`, region: 'VN' };
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
  it('C1-04: callback { state, params } lần đầu tạo gian hàng connecting, token lưu đã mã hoá, hạn lấy từ sàn; lần sau 200', async () => {
    const id = seller();
    // Body FE `main` gửi (G10): mọi query trừ `state` nằm trong `params`.
    const res = await app()
      .post('/api/v1/channel/shops/lazada/callback')
      .set('Authorization', `Bearer ${token}`)
      .send({ state: await stateFor(token), params: { code: `c-${id}`, app_key: '143465' } });
    expect(res.status).toBe(201);
    const body = ShopCallbackResult.parse(res.body);
    expect(body).toMatchObject({ created: true, reconnect: null, shop: { status: 'connecting', externalShopId: id } });
    expect(body.shops).toMatchObject([{ created: true, shop: { id: body.shop.id } }]);
    // AC-7: năng lực của sàn đi kèm gian hàng; hạn trả chưa nhập trước thiết lập.
    expect(body.shop).toMatchObject({ capabilities: { listingReview: true, hideBy: 'deactivate', splitLevel: 'unit', returnWindow: 'days' }, returnWindowDays: null });
    expect(JSON.stringify(res.body)).not.toContain(`tok-${id}`);

    const row = await shopRow(body.shop.id);
    expect(row.access_token_enc.toString('latin1')).not.toContain(`tok-${id}`);
    expect(row.refresh_token_enc).not.toBeNull();
    expect(row.refresh_expires_at.getTime()).toBeGreaterThan(Date.now() + 49 * DAY);

    const detail = await app().get(`/api/v1/channel/shops/${body.shop.id}`).set('Authorization', `Bearer ${token}`);
    expect(ShopDetail.parse(detail.body).statusHistory).toMatchObject([{ from: null, to: 'connecting', source: 'user' }]);

    const again = await app()
      .post('/api/v1/channel/shops/lazada/callback')
      .set('Authorization', `Bearer ${token}`)
      .send({ state: await stateFor(token), params: { code: `c-${id}` } });
    expect(again.status).toBe(200);
    expect(ShopCallbackResult.parse(again.body)).toMatchObject({ created: false, shop: { id: body.shop.id } });
  });

  it('body cũ { code, state } vẫn nhận, như params = { code } (luật chuyển tiếp 21 §18.6.3)', async () => {
    const id = seller();
    const res = await app()
      .post('/api/v1/channel/shops/lazada/callback')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: `c-${id}`, state: await stateFor(token) });
    expect(res.status).toBe(201);
    expect(ShopCallbackResult.parse(res.body).shop.externalShopId).toBe(id);
  });

  it('gửi cả params và code thì params thắng', async () => {
    const [a, b] = [seller(), seller()];
    const res = await app()
      .post('/api/v1/channel/shops/lazada/callback')
      .set('Authorization', `Bearer ${token}`)
      .send({ state: await stateFor(token), params: { code: `c-${a}` }, code: `c-${b}` });
    expect(res.status).toBe(201);
    expect(res.body.shop.externalShopId).toBe(a);
  });

  it('thiếu cả params lẫn code thì 422 errors.params; params quá 20 khoá, giá trị quá 2000 ký tự, giá trị không phải chuỗi thì 422', async () => {
    const state = await stateFor(token);
    const send = (body: object) =>
      app().post('/api/v1/channel/shops/lazada/callback').set('Authorization', `Bearer ${token}`).send(body);
    const none = await send({ state });
    expect(none.status).toBe(422);
    expect(none.body.code).toBe('validation_failed');
    expect(none.body.errors).toHaveProperty('params');
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v']));
    for (const params of [many, { code: 'x'.repeat(2001) }, { code: 1 }, ['c-x']]) {
      const res = await send({ state, params });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('validation_failed');
    }
  });

  it('params không có tham số adapter cần thì 409 marketplace_rejected missing_parameter', async () => {
    const res = await app()
      .post('/api/v1/channel/shops/lazada/callback')
      .set('Authorization', `Bearer ${token}`)
      .send({ state: await stateFor(token), params: { app_key: '143465' } });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'marketplace_rejected', platformCode: 'missing_parameter' });
  });

  it('thiếu state, state rỗng hoặc state quá 10 phút thì 422 oauth_state_invalid, không tạo gian hàng (US-GH-01 tc 5)', async () => {
    const id = seller();
    const fresh = await stateFor(token);
    const claims = JSON.parse(Buffer.from(fresh.split('.')[1]!, 'base64url').toString()) as { cid: string; sub: string; plt: string };
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() - 11 * 60_000);
    const expired = await signPurposeToken('oauth', { cid: claims.cid, sub: claims.sub, plt: claims.plt });
    vi.useRealTimers();
    for (const body of [{}, { state: '' }, { state: expired }]) {
      const res = await app()
        .post('/api/v1/channel/shops/lazada/callback')
        .set('Authorization', `Bearer ${token}`)
        .send({ ...body, params: { code: `c-${id}` } });
      expect(res.status).toBe(422);
      expect(res.body.type).toBe('/problems/oauth_state_invalid');
    }
    const { rows } = await testPool().query('select 1 from channel.shops where external_shop_id = $1', [id]);
    expect(rows).toHaveLength(0);
  });

  it('state sai, của người khác (kể cả CEO công ty khác) thì 422 oauth_state_invalid', async () => {
    const other = await addMember(company.companyId, 'admin');
    const otherCompany = await createCompany({ optionalModules: ['channel'] });
    const call = (state: string) =>
      app()
        .post('/api/v1/channel/shops/lazada/callback')
        .set('Authorization', `Bearer ${token}`)
        .send({ state, params: { code: 'c-x' } });
    for (const state of ['rác', await stateFor(other.token), await stateFor(otherCompany.ceo.token)]) {
      const res = await call(state);
      expect(res.status).toBe(422);
      expect(res.body.type).toBe('/problems/oauth_state_invalid');
    }
  });

  it('state của chính người bấm nhưng thuộc công ty khác công ty trong token thì 409 company_mismatch, không gọi sàn (21 §18.7.4)', async () => {
    const id = seller();
    const otherCompany = await createCompany({ optionalModules: ['channel'] });
    const own = await stateFor(token);
    const claims = JSON.parse(Buffer.from(own.split('.')[1]!, 'base64url').toString()) as { sub: string };
    const state = await signPurposeToken('oauth', { cid: otherCompany.companyId, sub: claims.sub, plt: 'lazada' });
    const res = await app()
      .post('/api/v1/channel/shops/lazada/callback')
      .set('Authorization', `Bearer ${token}`)
      .send({ state, params: { code: `c-${id}` } });
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/company_mismatch');
    const names = await testPool().query<{ id: string; name: string }>(
      'select id, name from core.companies where id = any($1)',
      [[otherCompany.companyId, company.companyId]],
    );
    const nameOf = (cid: string) => names.rows.find((r) => r.id === cid)!.name;
    expect(res.body.expected).toEqual({ id: otherCompany.companyId, name: nameOf(otherCompany.companyId) });
    expect(res.body.actual).toEqual({ id: company.companyId, name: nameOf(company.companyId) });
    const { rows } = await testPool().query('select 1 from channel.shops where external_shop_id = $1', [id]);
    expect(rows).toHaveLength(0);
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
    expect(bad.body).toMatchObject({ code: 'marketplace_unauthorized', platformCode: 'IllegalAccessToken' });
  });

  it('sàn không có adapter (kể cả khoá của Object) thì 422 marketplace_unsupported ở authorize-url, callback, token', async () => {
    const state = await stateFor(token);
    for (const platform of ['shopee', 'mock', 'xyz', 'toString', '__proto__', 'constructor']) {
      const calls = [
        app().get(`/api/v1/channel/shops/${platform}/authorize-url`),
        app().post(`/api/v1/channel/shops/${platform}/callback`).send({ state, params: { code: 'c-x' } }),
        app().post(`/api/v1/channel/shops/${platform}/token`).send({ accessToken: 'tok-x' }),
      ];
      for (const req of calls) {
        const res = await req.set('Authorization', `Bearer ${token}`);
        expect(res.status, platform).toBe(422);
        expect(res.body.code, platform).toBe('marketplace_unsupported');
      }
    }
  });
});

describe('một lần uỷ quyền ra nhiều gian hàng (tất cả hoặc không)', () => {
  const callback = async (bearer: string, code: string) =>
    app()
      .post('/api/v1/channel/shops/lazada/callback')
      .set('Authorization', `Bearer ${bearer}`)
      .send({ code, state: await stateFor(bearer) });
  const liveRows = async (ids: string[]) =>
    (
      await testPool().query<{ external_shop_id: string; status: string; company_id: string }>(
        'select external_shop_id, status, company_id from channel.shops where external_shop_id = any($1) and disconnected_at is null',
        [ids],
      )
    ).rows;

  it('hai gian hàng mới: 201, shops có đủ hai, cả hai connecting; shop/created là của phần tử đầu', async () => {
    const [a, b] = [seller(), seller()];
    const res = await callback(token, `c-${a}+${b}`);
    expect(res.status).toBe(201);
    const body = ShopCallbackResult.parse(res.body);
    expect(body.shops.map((s) => s.shop.externalShopId)).toEqual([a, b]);
    expect(body.shops.every((s) => s.created && s.shop.status === 'connecting')).toBe(true);
    expect(body.shop).toEqual(body.shops[0]!.shop);
    expect(body.created).toBe(true);
    // Token không lộ ra response, kể cả khi nhiều gian hàng (AC-S4).
    expect(JSON.stringify(res.body)).not.toMatch(/tok-|ref-/);
    const rows = await liveRows([a, b]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'connecting' && r.company_id === company.companyId)).toBe(true);
  });

  it('trộn: gian hàng đầu đã có, gian hàng sau mới thì vẫn 201 (theo gian hàng tạo mới, không theo phần tử đầu)', async () => {
    const [a, b] = [seller(), seller()];
    expect((await connect(token, a)).status).toBe(201);
    const res = await callback(token, `c-${a}+${b}`);
    expect(res.status).toBe(201);
    const body = ShopCallbackResult.parse(res.body);
    expect(body.created).toBe(false);
    expect(body.shops.map((s) => s.created)).toEqual([false, true]);
  });

  it('một gian hàng đang gắn công ty khác thì 409 shop_connected_elsewhere, không ghi gian hàng nào', async () => {
    const [a, b] = [seller(), seller()];
    const other = await createCompany({ optionalModules: ['channel'] });
    expect((await connect(other.ceo.token, b)).status).toBe(201);
    const res = await callback(token, `c-${a}+${b}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('shop_connected_elsewhere');
    expect(await liveRows([a])).toHaveLength(0);
  });

  it('adapter trả gian hàng lặp thì gộp theo mã shop của sàn', async () => {
    const a = seller();
    const res = await callback(token, `c-${a}+${a}`);
    expect(res.status).toBe(201);
    expect(ShopCallbackResult.parse(res.body).shops).toHaveLength(1);
  });

  it('uỷ quyền không có gian hàng nào thì 409 marketplace_rejected no_shop, không 500', async () => {
    const res = await callback(token, 'none');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'marketplace_rejected', platformCode: 'no_shop' });
  });
});

describe('kết nối bằng token console', () => {
  it('tạo gian hàng; gọi lại khi đang connecting chỉ thay token', async () => {
    const id = seller();
    const first = await connect(token, id);
    expect(first.status).toBe(201);
    // Cùng dạng với callback: có `shops[]` (Documents/21 §18.4).
    expect(ShopCallbackResult.parse(first.body).shops).toMatchObject([{ created: true, shop: { externalShopId: id } }]);
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

  it('markNeedsReauth khi đang thiết lập: connecting sang needs_reauth; nối lại thì về connecting', async () => {
    const shop = (await connect(token, seller())).body.shop;
    await withCompany(company.companyId, () => markNeedsReauth(shop.id, 'seller gỡ ứng dụng'));
    expect((await shopRow(shop.id)).status).toBe('needs_reauth');
    // Đã needs_reauth thì gọi lại không ghi thêm lịch sử.
    await withCompany(company.companyId, () => markNeedsReauth(shop.id, 'seller gỡ ứng dụng'));
    const detail = await app().get(`/api/v1/channel/shops/${shop.id}`).set('Authorization', `Bearer ${token}`);
    expect(detail.body.statusHistory.filter((h: { to: string }) => h.to === 'needs_reauth')).toHaveLength(1);

    // Chưa có mốc lấy đơn nên không được về active (CHECK shops_active_cutoff): resume_setup về connecting.
    const resumed = await connect(token, shop.externalShopId);
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ created: false, reconnect: null, shop: { id: shop.id, status: 'connecting' } });
  });

  it('markNeedsReauth: active sang needs_reauth, nguồn hệ thống; trạng thái khác thì bỏ qua', async () => {
    const shop = (await connect(token, seller())).body.shop;
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

  it('C1-04q: Sale, Kho gọi callback hay token thì 403 forbidden; không token 401', async () => {
    for (const role of ['sale', 'warehouse'] as const) {
      const member = await addMember(company.companyId, role);
      const cb = await app()
        .post('/api/v1/channel/shops/lazada/callback')
        .set('Authorization', `Bearer ${member.token}`)
        .send({ state: 'x', params: { code: 'c-x' } });
      expect(cb.status, role).toBe(403);
      expect(cb.body.code, role).toBe('forbidden');
      const tk = await connect(member.token, seller());
      expect(tk.status, role).toBe(403);
      expect(tk.body.code, role).toBe('forbidden');
    }
    const anon = await app().post('/api/v1/channel/shops/lazada/callback').send({ state: 'x', params: { code: 'c-x' } });
    expect(anon.status).toBe(401);
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
