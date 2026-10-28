import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarketplaceError } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { createLazadaAdapter, signLazada } from '#src/modules/channel/channel/service/marketplaces/lazada.ts';

const config = {
  appKey: '143465',
  appSecret: 'secret',
  redirectUrl: 'https://fe.test/channel/lazada/callback',
  apiUrl: 'https://api.test/rest',
  authUrl: 'https://auth.test',
};

function fakeFetch(...responses: (Response | Error)[]) {
  const fn = vi.fn<typeof fetch>();
  for (const r of responses) {
    if (r instanceof Error) fn.mockRejectedValueOnce(r);
    else fn.mockResolvedValueOnce(r);
  }
  return fn;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => vi.useRealTimers());

describe('signLazada', () => {
  it('ký apiPath cộng các cặp key+value xếp theo tên, hex viết hoa', () => {
    const expected = createHmac('sha256', 'secret').update('/seller/geta1b2').digest('hex').toUpperCase();
    expect(signLazada('/seller/get', { b: '2', a: '1' }, 'secret')).toBe(expected);
  });
});

describe('adapter Lazada', () => {
  it('URL uỷ quyền mang client_id, redirect_uri, force_auth và state', () => {
    const url = new URL(createLazadaAdapter(config).authorizeUrl('st'));
    expect(`${url.origin}${url.pathname}`).toBe('https://auth.test/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      force_auth: 'true',
      redirect_uri: config.redirectUrl,
      client_id: '143465',
      state: 'st',
    });
  });

  it('thiếu app key hoặc secret thì báo unsupported, không gọi sàn', async () => {
    const fetchFn = fakeFetch();
    const adapter = createLazadaAdapter({ ...config, appSecret: undefined }, fetchFn);
    await expect(adapter.getSeller('t')).rejects.toMatchObject({ kind: 'unsupported' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('đổi code lấy token, hạn tính từ expires_in và refresh_expires_in', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-28T00:00:00Z') });
    const fetchFn = fakeFetch(
      json({ code: '0', access_token: 'at', refresh_token: 'rt', expires_in: 864000, refresh_expires_in: 4320000 }),
    );
    const tokens = await createLazadaAdapter(config, fetchFn).exchangeCode('c1');
    expect(tokens).toEqual({
      accessToken: 'at',
      refreshToken: 'rt',
      accessExpiresAt: new Date('2026-11-07T00:00:00Z'),
      refreshExpiresAt: new Date('2026-12-17T00:00:00Z'),
    });
    const called = new URL(String(fetchFn.mock.calls[0]?.[0]));
    expect(called.pathname).toBe('/rest/auth/token/create');
    expect(called.searchParams.get('code')).toBe('c1');
    const params = Object.fromEntries([...called.searchParams].filter(([k]) => k !== 'sign'));
    expect(called.searchParams.get('sign')).toBe(signLazada('/auth/token/create', params, 'secret'));
  });

  it('đọc seller_id dạng số thành chuỗi', async () => {
    const fetchFn = fakeFetch(json({ code: '0', data: { seller_id: 200185074242, name: 'Shop thử' } }));
    expect(await createLazadaAdapter(config, fetchFn).getSeller('t')).toEqual({
      externalShopId: '200185074242',
      shopName: 'Shop thử',
      region: 'VN',
    });
  });

  it.each([
    ['mất mạng', new Error('ECONNRESET'), 'unavailable', null],
    ['HTTP 502', json({}, 502), 'unavailable', 'http_502'],
    ['lỗi phía sàn', json({ code: 'ServiceTimeout', type: 'ISP', message: 'x' }), 'unavailable', 'ServiceTimeout'],
    ['token hết hạn', json({ code: 'IllegalAccessToken', type: 'ISV', message: 'x' }), 'unauthorized', 'IllegalAccessToken'],
    // Payload thật Lazada trả ngày 28/10/2026: mã token mang type ISP, vẫn phải là unauthorized, không phải lỗi tạm.
    ['code sai (thật)', json({ code: 'InvalidCode', type: 'ISP', message: 'Invalid authorization code' }), 'unauthorized', 'InvalidCode'],
    [
      'refresh token sai (thật)',
      json({ code: 'IllegalRefreshToken', type: 'ISP', message: 'The specified refresh token is invalid or expired' }),
      'unauthorized',
      'IllegalRefreshToken',
    ],
    ['sàn từ chối', json({ code: 'E207', type: 'ISV', message: 'SKU not exist' }), 'rejected', 'E207'],
  ])('%s → %s', async (_name, response, kind, platformCode) => {
    const err = await createLazadaAdapter(config, fakeFetch(response))
      .getSeller('t')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarketplaceError);
    expect(err).toMatchObject({ kind, platformCode });
  });
});
