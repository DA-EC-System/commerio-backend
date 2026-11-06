import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MarketplaceError } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import {
  createTiktokClient,
  packTiktokToken,
  signTiktok,
  tiktokError,
  unpackTiktokToken,
} from '#src/modules/channel/channel/service/marketplaces/tiktok-client.ts';
import { createTiktokAdapter, tiktokRemoteState } from '#src/modules/channel/channel/service/marketplaces/tiktok.ts';

const config = {
  appKey: 'appk',
  appSecret: 'apps',
  serviceId: '7703485233496540935',
  apiUrl: 'https://open.test',
  authUrl: 'https://auth.test',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ok = (data: unknown) => json({ code: 0, message: 'Success', request_id: 'r', data });
const SHOP = { id: '7495013067939481105', name: 'Shop thử', region: 'VN', cipher: 'ROW_cipher', seller_type: 'LOCAL', code: 'VNLC' };
const packed = (token = 'TTP_at') => packTiktokToken({ token, cipher: SHOP.cipher, shopId: SHOP.id });

function fakeFetch(...responses: (Response | Error)[]) {
  const fn = vi.fn<typeof fetch>();
  for (const r of responses) {
    if (r instanceof Error) fn.mockRejectedValueOnce(r);
    else fn.mockResolvedValueOnce(r);
  }
  return fn;
}
const urlOf = (fn: ReturnType<typeof fakeFetch>, i: number) => new URL(String(fn.mock.calls[i]?.[0]));
const initOf = (fn: ReturnType<typeof fakeFetch>, i: number) => fn.mock.calls[i]?.[1] as RequestInit & { headers: Record<string, string> };

describe('signTiktok', () => {
  it('khớp ví dụ của docv2 "Sign your API request" (secret e59af819cc, app_key 29a39d, timestamp 1623812664)', () => {
    // https://partner.tiktokshop.com/docv2/page/sign-your-api-request (tra 06/11/2026): sign trong lệnh curl mẫu.
    expect(signTiktok('/authorization/202309/shops', { app_key: '29a39d', timestamp: '1623812664' }, '', 'e59af819cc')).toBe(
      'b596b73e0cc6de07ac26f036364178ab16b0a907af13d43f0a0cd2345f582dc8',
    );
  });

  it('chuỗi ký của ví dụ "Create a hash to sign" (secret abc000def111, app_key 123456, timestamp 1234567890)', () => {
    // Trang docv2 chỉ ghi chuỗi cần ký, không ghi kết quả: so với HMAC tự tính trên đúng chuỗi đó.
    const message = 'abc000def111/authorization/202309/shopsapp_key123456timestamp1234567890abc000def111';
    expect(signTiktok('/authorization/202309/shops', { timestamp: '1234567890', app_key: '123456' }, '', 'abc000def111')).toBe(
      createHmac('sha256', 'abc000def111').update(message).digest('hex'),
    );
  });

  it('bỏ sign và access_token, xếp key theo tên, nối body cuối (ví dụ Update Shop Webhook của docv2)', () => {
    const body = '{"address":"https://partner.tiktokshop.com","event_type":"PACKAGE_UPDATE"}';
    const message = `s/event/202309/webhooksapp_key68xu9ks5p4i8shop_cipherROW_xkMbgAAAeVAQra0eZWebFQq5aIKtimestamp1696909648${body}s`;
    const query = { timestamp: '1696909648', sign: 'cũ', access_token: 'bí mật', shop_cipher: 'ROW_xkMbgAAAeVAQra0eZWebFQq5aIK', app_key: '68xu9ks5p4i8' };
    const sign = signTiktok('/event/202309/webhooks', query, body, 's');
    expect(sign).toBe(createHmac('sha256', 's').update(message).digest('hex'));
    expect(sign).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('gói token TikTok', () => {
  it('pack rồi unpack ra đúng token, cipher, mã shop; chuỗi không chứa token thô', () => {
    const p = packTiktokToken({ token: 'TTP_abc', cipher: 'ROW_x', shopId: '1' });
    expect(p.startsWith('tts1.')).toBe(true);
    expect(p).not.toContain('TTP_abc');
    expect(unpackTiktokToken(p)).toEqual({ token: 'TTP_abc', cipher: 'ROW_x', shopId: '1' });
  });

  it.each(['TTP_thô', 'tts1.!!!', `tts1.${Buffer.from('{"t":1}').toString('base64url')}`, 'tts1.'])('chuỗi hỏng %s → unauthorized token_format', (bad) => {
    expect(() => unpackTiktokToken(bad)).toThrow(expect.objectContaining({ kind: 'unauthorized', platformCode: 'token_format' }));
  });
});

describe('tiktokError', () => {
  it.each([
    [36009002, 'Too many requests', 'unavailable'],
    [36009003, 'Internal error', 'unavailable'],
    [36009007, 'Request timeout', 'unavailable'],
    [105002, 'Expired credentials', 'unauthorized'],
    [36009005, 'invalid access token', 'unauthorized'],
    [101000, 'Invalid query or header', 'unauthorized'],
    [36009004, 'Invalid credentials. The x-tts-access-token header is invalid.', 'unauthorized'],
    [36009004, "Invalid credentials. The 'access_token' header is invalid.", 'unauthorized'],
    [36009004, 'Invalid shop_cipher.', 'rejected'],
    [36009004, 'Invalid timestamp. The value of the timestamp query parameter must not be earlier than 5 minutes', 'rejected'],
    [106001, 'Invalid credentials. The sign query parameter is invalid.', 'rejected'],
    [105005, 'Access denied', 'rejected'],
    [36004004, 'invalid auth code', 'rejected'],
  ] as const)('mã %s → %s, giữ mã và câu gốc', (code, message, kind) => {
    expect(tiktokError(code, message)).toMatchObject({ kind, platformCode: String(code), platformMessage: message });
  });
});

describe('client TikTok', () => {
  it('ký, đặt header token và shop_cipher từ token đã gói; body gửi đúng chuỗi đã ký', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    try {
      const fetchFn = fakeFetch(ok({ x: 1 }));
      const client = createTiktokClient(config, fetchFn);
      const data = await client.call('POST', '/product/202502/products/search', { token: packed(), query: { page_size: 100, page_token: undefined }, body: { status: 'ALL' } });
      expect(data).toEqual({ x: 1 });
      const u = urlOf(fetchFn, 0);
      const init = initOf(fetchFn, 0);
      expect(u.origin + u.pathname).toBe('https://open.test/product/202502/products/search');
      expect(Object.fromEntries([...u.searchParams].filter(([k]) => k !== 'sign'))).toEqual({
        app_key: 'appk',
        timestamp: '1700000000',
        page_size: '100',
        shop_cipher: 'ROW_cipher',
      });
      expect(init.headers).toEqual({ 'content-type': 'application/json', 'x-tts-access-token': 'TTP_at' });
      expect(init.body).toBe('{"status":"ALL"}');
      const query = Object.fromEntries([...u.searchParams].filter(([k]) => k !== 'sign'));
      expect(u.searchParams.get('sign')).toBe(signTiktok(u.pathname, query, '{"status":"ALL"}', 'apps'));
      // Token không bao giờ nằm trên URL.
      expect(String(fetchFn.mock.calls[0]?.[0])).not.toContain('TTP_at');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shopCipher: false thì không gửi shop_cipher', async () => {
    const fetchFn = fakeFetch(ok({}));
    await createTiktokClient(config, fetchFn).call('GET', '/seller/202309/shops', { token: packed(), shopCipher: false });
    expect(urlOf(fetchFn, 0).searchParams.has('shop_cipher')).toBe(false);
  });

  it.each([
    ['lỗi mạng', new Error('ECONNRESET'), 'unavailable', null],
    ['HTTP 503', json({}, 503), 'unavailable', 'http_503'],
    ['HTTP 429', json({ code: 36009002 }, 429), 'unavailable', 'http_429'],
    ['body không phải JSON', new Response('<html>', { status: 200 }), 'unavailable', 'http_200'],
    ['token hết hạn trong body', json({ code: 105002, message: 'Expired credentials' }, 401), 'unauthorized', '105002'],
    ['lỗi nghiệp vụ', json({ code: 12052180, message: 'too many' }), 'rejected', '12052180'],
  ] as const)('%s → %s', async (_name, response, kind, platformCode) => {
    const err = await createTiktokClient(config, fakeFetch(response))
      .call('GET', '/x', { token: packed() })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarketplaceError);
    expect(err).toMatchObject({ kind, platformCode });
    expect(String((err as Error).message)).not.toContain('TTP_at');
  });

  it('thiếu key hoặc secret thì unsupported, không gọi mạng; hết hạn mức ngày thì unavailable daily_call_limit', async () => {
    const fetchFn = fakeFetch();
    await expect(createTiktokClient({ ...config, appSecret: undefined }, fetchFn).call('GET', '/x')).rejects.toMatchObject({ kind: 'unsupported' });
    await expect(createTiktokClient({ ...config, reserveCall: async () => false }, fetchFn).callAuth('/api/v2/token/get', {})).rejects.toMatchObject({
      kind: 'unavailable',
      platformCode: 'daily_call_limit',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('adapter TikTok: nối gian hàng', () => {
  it('connectMethods theo cấu hình: đủ thì oauth + token, thiếu service id thì token, thiếu secret thì rỗng', () => {
    expect(createTiktokAdapter(config).connectMethods()).toEqual(['oauth', 'token']);
    expect(createTiktokAdapter({ ...config, serviceId: undefined }).connectMethods()).toEqual(['token']);
    expect(createTiktokAdapter({ ...config, appSecret: undefined }).connectMethods()).toEqual([]);
  });

  it('URL uỷ quyền bản ROW mang service_id và state, không mang redirect_uri; thiếu service id thì unsupported', () => {
    const url = new URL(createTiktokAdapter(config).authorizeUrl('st'));
    expect(url.origin + url.pathname).toBe('https://services.tiktokshop.com/open/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({ service_id: config.serviceId, state: 'st' });
    expect(() => createTiktokAdapter({ ...config, serviceId: undefined }).authorizeUrl('st')).toThrow(expect.objectContaining({ kind: 'unsupported' }));
  });

  it('capabilities: duyệt listing, ẩn bằng deactivate, tách theo SKU, hạn trả theo trạng thái sàn', () => {
    expect(createTiktokAdapter(config).capabilities).toEqual({ listingReview: true, hideBy: 'deactivate', splitLevel: 'sku', returnWindow: 'platform_status' });
  });

  it('exchangeCode: đổi auth_code (grant_type authorized_code), hạn là mốc Unix tuyệt đối, mỗi gian hàng gói cipher riêng', async () => {
    const fetchFn = fakeFetch(
      ok({ access_token: 'TTP_at', access_token_expire_in: 1794588545, refresh_token: 'TTP_rt', refresh_token_expire_in: 4915695420 }),
      ok({ shops: [SHOP, { ...SHOP, id: '2', name: 'Shop 2', region: 'TH', cipher: 'ROW_2' }] }),
    );
    const shops = await createTiktokAdapter(config, fetchFn).exchangeCode({ code: 'c1', app_key: 'appk', locale: 'vi', shop_region: 'VN' });
    const token = urlOf(fetchFn, 0);
    expect(token.origin + token.pathname).toBe('https://auth.test/api/v2/token/get');
    expect(Object.fromEntries(token.searchParams)).toEqual({ app_key: 'appk', app_secret: 'apps', auth_code: 'c1', grant_type: 'authorized_code' });
    const authorized = urlOf(fetchFn, 1);
    expect(authorized.pathname).toBe('/authorization/202309/shops');
    expect(authorized.searchParams.has('shop_cipher')).toBe(false);
    expect(initOf(fetchFn, 1).headers['x-tts-access-token']).toBe('TTP_at');
    expect(shops.map((s) => [s.externalShopId, s.shopName, s.region])).toEqual([
      [SHOP.id, 'Shop thử', 'VN'],
      ['2', 'Shop 2', 'TH'],
    ]);
    expect(shops[0]!.tokens.accessExpiresAt).toEqual(new Date(1794588545 * 1000));
    expect(shops[0]!.tokens.refreshExpiresAt).toEqual(new Date(4915695420 * 1000));
    expect(unpackTiktokToken(shops[0]!.tokens.accessToken)).toEqual({ token: 'TTP_at', cipher: SHOP.cipher, shopId: SHOP.id });
    expect(unpackTiktokToken(shops[1]!.tokens.refreshToken!)).toEqual({ token: 'TTP_rt', cipher: 'ROW_2', shopId: '2' });
  });

  it.each([
    [{}, 'missing_parameter'],
    [{ code: 'null', error: 'auth_denied' }, 'auth_denied'],
    [{ code: 'null' }, 'missing_parameter'],
    [{ code: 'c', app_key: 'app-khác' }, 'app_key_mismatch'],
  ])('callback %j → rejected %s, không gọi mạng', async (params, platformCode) => {
    const fetchFn = fakeFetch();
    await expect(createTiktokAdapter(config, fetchFn).exchangeCode(params)).rejects.toMatchObject({ kind: 'rejected', platformCode });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('code hết hạn (36004004) → rejected kèm mã sàn', async () => {
    const fetchFn = fakeFetch(json({ code: 36004004, message: 'invalid auth code' }));
    await expect(createTiktokAdapter(config, fetchFn).exchangeCode({ code: 'cũ' })).rejects.toMatchObject({ kind: 'rejected', platformCode: '36004004' });
  });

  it('connectWithToken có refresh token: làm mới một lần rồi đọc gian hàng bằng token mới', async () => {
    const fetchFn = fakeFetch(ok({ access_token: 'TTP_new', access_token_expire_in: 1800000000, refresh_token: 'TTP_rt2', refresh_token_expire_in: 1900000000 }), ok({ shops: [SHOP] }));
    const [shop] = await createTiktokAdapter(config, fetchFn).connectWithToken({ accessToken: 'TTP_old', refreshToken: 'TTP_rt' });
    expect(Object.fromEntries(urlOf(fetchFn, 0).searchParams)).toMatchObject({ refresh_token: 'TTP_rt', grant_type: 'refresh_token' });
    expect(initOf(fetchFn, 1).headers['x-tts-access-token']).toBe('TTP_new');
    expect(unpackTiktokToken(shop!.tokens.accessToken).token).toBe('TTP_new');
    expect(shop!.tokens.accessExpiresAt).toEqual(new Date(1800000000 * 1000));
  });

  it('connectWithToken chỉ access token: không làm mới, hạn để trống, refresh null', async () => {
    const fetchFn = fakeFetch(ok({ shops: [SHOP] }));
    const [shop] = await createTiktokAdapter(config, fetchFn).connectWithToken({ accessToken: 'TTP_only', refreshToken: null });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(shop!.tokens).toMatchObject({ refreshToken: null, accessExpiresAt: null, refreshExpiresAt: null });
  });

  it('refreshToken giữ cipher và mã shop của chuỗi refresh đã gói', async () => {
    const fetchFn = fakeFetch(ok({ access_token: 'TTP_a2', access_token_expire_in: 1800000000, refresh_token: 'TTP_r2', refresh_token_expire_in: 1900000000 }));
    const tokens = await createTiktokAdapter(config, fetchFn).refreshToken(packed('TTP_r1'));
    expect(urlOf(fetchFn, 0).searchParams.get('refresh_token')).toBe('TTP_r1');
    expect(unpackTiktokToken(tokens.accessToken)).toEqual({ token: 'TTP_a2', cipher: SHOP.cipher, shopId: SHOP.id });
    expect(unpackTiktokToken(tokens.refreshToken!)).toEqual({ token: 'TTP_r2', cipher: SHOP.cipher, shopId: SHOP.id });
    expect(tokens.refreshExpiresAt).toEqual(new Date(1900000000 * 1000));
  });

  it('sàn từ chối refresh token → unauthorized (gian hàng nối lại); lỗi tạm giữ unavailable', async () => {
    await expect(createTiktokAdapter(config, fakeFetch(json({ code: 36004005, message: 'invalid refresh token' }))).refreshToken(packed('TTP_r1'))).rejects.toMatchObject({
      kind: 'unauthorized',
      platformCode: '36004005',
    });
    await expect(createTiktokAdapter(config, fakeFetch(json({}, 502))).refreshToken(packed('TTP_r1'))).rejects.toMatchObject({ kind: 'unavailable' });
  });
});

describe('adapter TikTok: SKU', () => {
  const product = (id: string, status: string, skus: object[]) => ({ id, title: `SP ${id}`, status, skus });
  const sku = (id: string, sellerSku: string, qty: number[] = [3], extra: object = {}) => ({
    id,
    seller_sku: sellerSku,
    inventory: qty.map((quantity, i) => ({ quantity, warehouse_id: `w${i}` })),
    ...extra,
  });

  it('listSkus lật page_token tới hết, tồn là tổng các kho, bỏ sản phẩm đã xoá', async () => {
    const fetchFn = fakeFetch(
      ok({ total_count: 3, next_page_token: 'p2', products: [product('1', 'ACTIVATE', [sku('11', 'AO-M', [2, 5])]), product('2', 'DELETED', [sku('21', 'CU')])] }),
      ok({ total_count: 3, next_page_token: '', products: [product('3', 'PENDING', [sku('31', 'QUAN-L', [0])])] }),
    );
    const skus = await createTiktokAdapter(config, fetchFn).listSkus!(packed());
    expect(skus).toEqual([
      { externalProductId: '1', externalSkuId: '11', sellerSku: 'AO-M', title: 'SP 1', state: 'live', rejectReason: null, quantity: 7 },
      { externalProductId: '3', externalSkuId: '31', sellerSku: 'QUAN-L', title: 'SP 3', state: 'review', rejectReason: null, quantity: 0 },
    ]);
    expect(urlOf(fetchFn, 0).searchParams.has('page_token')).toBe(false);
    expect(urlOf(fetchFn, 1).searchParams.get('page_token')).toBe('p2');
    expect(urlOf(fetchFn, 1).searchParams.get('page_size')).toBe('100');
    expect(initOf(fetchFn, 0).body).toBe('{"status":"ALL"}');
  });

  it('listSkus: gian hàng hơn 10000 sản phẩm thì rejected too_many_products, không trả thiếu', async () => {
    const fetchFn = fakeFetch(ok({ total_count: 10001, next_page_token: 'p2', products: [] }));
    await expect(createTiktokAdapter(config, fetchFn).listSkus!(packed())).rejects.toMatchObject({ kind: 'rejected', platformCode: 'too_many_products' });
  });

  it('getSkus chia lô 10 SellerSku (giới hạn seller_skus) và chỉ trả SKU được hỏi', async () => {
    const wanted = Array.from({ length: 12 }, (_, i) => `S${i}`);
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const asked = (JSON.parse(String(init?.body)) as { seller_skus: string[] }).seller_skus;
      return ok({ products: [product('p', 'ACTIVATE', [...asked.map((s, i) => sku(`${s}-${i}`, s)), sku('x', 'KHÁC')])] });
    });
    const skus = await createTiktokAdapter(config, fetchFn).getSkus(packed(), wanted);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect((JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)) as { seller_skus: string[] }).seller_skus).toHaveLength(10);
    expect(skus.map((s) => s.sellerSku)).toEqual(wanted);
  });

  it.each([
    ['ACTIVATE', {}, 'live'],
    ['ACTIVATE', { status_info: { status: 'DEACTIVATED', deactivation_source: 'SELLER' } }, 'inactive'],
    ['ACTIVATE', { status_info: { status: 'DEACTIVATED', deactivation_source: 'PLATFORM' } }, 'hold'],
    ['PENDING', {}, 'review'],
    ['FAILED', {}, 'rejected'],
    ['FREEZE', {}, 'hold'],
    ['PLATFORM_DEACTIVATED', {}, 'hold'],
    ['SELLER_DEACTIVATED', {}, 'inactive'],
    ['DRAFT', {}, 'inactive'],
    ['DELETED', {}, 'deleted'],
    ['LẠ', {}, 'inactive'],
  ] as const)('trạng thái %s %j → %s', (status, s, state) => {
    expect(tiktokRemoteState(status, s)).toBe(state);
  });

  it('năng lực chưa làm (đẩy sản phẩm, tồn giá, ẩn) báo unsupported', async () => {
    const adapter = createTiktokAdapter(config, fakeFetch());
    await expect(adapter.listCategories(packed())).rejects.toMatchObject({ kind: 'unsupported' });
    await expect(adapter.updatePriceQuantity(packed(), [])).rejects.toMatchObject({ kind: 'unsupported' });
    await expect(adapter.deactivate(packed(), '1', '2')).rejects.toMatchObject({ kind: 'unsupported' });
  });
});
