// Nối gian hàng TikTok qua route thật với adapter TikTok thật và sàn giả (#217 AC-2, AC-3, AC-5): callback mang đúng
// các query TikTok trả (app_key, code, locale, shop_region), token lưu đã gói cipher và mã hoá, không lộ ra response.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshShopToken } from '#src/modules/channel/channel/service/shops.ts';
import { ShopCallbackResult } from '#src/modules/channel/channel/api/schemas.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { createTiktokAdapter } from '#src/modules/channel/channel/service/marketplaces/tiktok.ts';
import { unpackTiktokToken } from '#src/modules/channel/channel/service/marketplaces/tiktok-client.ts';
import { signPurposeToken } from '#src/shared/auth/purpose-token.ts';
import { decryptBytes } from '#src/shared/crypto/aes-gcm.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';

const config = { appKey: 'tk', appSecret: 'ts', serviceId: 'svc', apiUrl: 'https://open.tiktok.test', authUrl: 'https://auth.tiktok.test' };
const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, message: 'Success', data }), { status: 200 });
const key = Buffer.alloc(32, 7); // CHANNEL_TOKEN_KEY của vitest.config.ts

let shopId = '';
let cipher = '';
let issued = 0;
const fetchFn = vi.fn<typeof fetch>(async (url) => {
  const u = new URL(String(url));
  if (u.pathname === '/api/v2/token/get' || u.pathname === '/api/v2/token/refresh') {
    issued += 1;
    return ok({
      access_token: `TTP_access_${issued}`,
      access_token_expire_in: 1794588545 + issued,
      refresh_token: `TTP_refresh_${issued}`,
      refresh_token_expire_in: 4915695420,
    });
  }
  if (u.pathname === '/authorization/202309/shops') return ok({ shops: [{ id: shopId, name: 'Shop thử TikTok', region: 'VN', cipher, seller_type: 'LOCAL' }] });
  return ok({});
});

const app = () => request(testApp());
let company: Awaited<ReturnType<typeof createCompany>>;

beforeAll(async () => {
  registerAdapter('tiktok', createTiktokAdapter(config, fetchFn));
  company = await createCompany({ optionalModules: ['channel'] });
});
afterAll(() => resetAdapters());
beforeEach(() => {
  shopId = String(7_000_000_000_000_000_000n + BigInt(Math.floor(Math.random() * 1e12)));
  cipher = `ROW_${randomUUID().replace(/-/g, '')}`;
  fetchFn.mockClear();
});

async function stateFor(platform: string): Promise<string> {
  const res = await app().get(`/api/v1/channel/shops/${platform}/authorize-url`).set('Authorization', `Bearer ${company.ceo.token}`);
  expect(res.status).toBe(200);
  return new URL(res.body.url).searchParams.get('state')!;
}

const callback = (state: string, params: Record<string, string>) =>
  app().post('/api/v1/channel/shops/tiktok/callback').set('Authorization', `Bearer ${company.ceo.token}`).send({ state, params });

async function storedTokens(id: string) {
  const { rows } = await testPool().query('select * from channel.shops where id = $1', [id]);
  const row = rows[0];
  return {
    row,
    access: decryptBytes(row.access_token_enc, `${id}:access`, key).toString(),
    refresh: decryptBytes(row.refresh_token_enc, `${id}:refresh`, key).toString(),
  };
}

describe('nối gian hàng TikTok (#217)', () => {
  it('AC-2: callback có state của app tạo gian hàng connecting, đúng mã shop và tên; token, cipher không có trong response', async () => {
    const res = await callback(await stateFor('tiktok'), { app_key: 'tk', code: 'c1', locale: 'vi-VN', shop_region: 'VN' });
    expect(res.status).toBe(201);
    const body = ShopCallbackResult.parse(res.body);
    expect(body.shop).toMatchObject({ status: 'connecting', platform: 'tiktok', externalShopId: shopId, shopName: 'Shop thử TikTok' });
    expect(body.shop.capabilities).toEqual({ listingReview: true, hideBy: 'deactivate', splitLevel: 'sku', returnWindow: 'platform_status' });
    expect(JSON.stringify(res.body)).not.toMatch(new RegExp(`TTP_|${cipher}|tts1\\.`));

    const { row, access, refresh } = await storedTokens(body.shop.id);
    expect(unpackTiktokToken(access)).toEqual({ token: 'TTP_access_' + String(issued), cipher, shopId });
    expect(unpackTiktokToken(refresh).cipher).toBe(cipher);
    expect(row.access_expires_at).toEqual(new Date((1794588545 + issued) * 1000));
  });

  it('AC-3: state sai, state của sàn khác, hoặc thiếu state thì 422 oauth_state_invalid, không gọi sàn, không tạo gian hàng', async () => {
    const fresh = await stateFor('tiktok');
    const claims = JSON.parse(Buffer.from(fresh.split('.')[1]!, 'base64url').toString()) as { cid: string; sub: string };
    const lazadaState = await signPurposeToken('oauth', { cid: claims.cid, sub: claims.sub, plt: 'lazada' });
    for (const state of ['sai', lazadaState, '']) {
      const res = await callback(state, { app_key: 'tk', code: 'c1', locale: 'vi-VN', shop_region: 'VN' });
      expect(res.status).toBe(422);
      expect(res.body.type).toBe('/problems/oauth_state_invalid');
    }
    expect(fetchFn).not.toHaveBeenCalled();
    const { rows } = await testPool().query("select 1 from channel.shops where platform = 'tiktok' and external_shop_id = $1", [shopId]);
    expect(rows).toHaveLength(0);
  });

  it('dán token (dự phòng): refresh token làm mới một lần rồi tạo gian hàng', async () => {
    const res = await app()
      .post('/api/v1/channel/shops/tiktok/token')
      .set('Authorization', `Bearer ${company.ceo.token}`)
      .send({ accessToken: 'TTP_dan_tay', refreshToken: 'TTP_refresh_dan_tay' });
    expect(res.status).toBe(201);
    expect(ShopCallbackResult.parse(res.body).shop.externalShopId).toBe(shopId);
    expect(new URL(String(fetchFn.mock.calls[0]?.[0])).searchParams.get('refresh_token')).toBe('TTP_refresh_dan_tay');
  });

  it('AC-5: làm mới token lưu cặp token mới và hạn mới đúng mốc TikTok trả, giữ cipher', async () => {
    const res = await callback(await stateFor('tiktok'), { app_key: 'tk', code: 'c2' });
    const id = ShopCallbackResult.parse(res.body).shop.id;
    // Đưa gian hàng về `active` sắp hết hạn access (làm mới chỉ chạy cho gian hàng active, còn dưới ngưỡng).
    await testPool().query("update channel.shops set status = 'active', order_cutoff_at = now(), access_expires_at = now() + interval '1 hour' where id = $1", [id]);
    expect(await refreshShopToken(company.companyId, id)).toBe('refreshed');
    const { row, access, refresh } = await storedTokens(id);
    expect(unpackTiktokToken(access)).toEqual({ token: `TTP_access_${issued}`, cipher, shopId });
    expect(unpackTiktokToken(refresh).token).toBe(`TTP_refresh_${issued}`);
    expect(row.access_expires_at).toEqual(new Date((1794588545 + issued) * 1000));
  });
});
