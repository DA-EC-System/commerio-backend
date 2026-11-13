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
import { logger } from '#src/shared/logger.ts';

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
    await expect(createTiktokClient({ ...config, reserveCall: async () => 'daily_call_limit' as const }, fetchFn).callAuth('/api/v2/token/get', {})).rejects.toMatchObject({
      kind: 'unavailable',
      platformCode: 'daily_call_limit',
    });
    // #215: hết phần của công ty, cùng mã với Lazada (21 §18.6.8).
    await expect(createTiktokClient({ ...config, reserveCall: async () => 'company_call_limit' as const }, fetchFn).call('GET', '/x')).rejects.toMatchObject({
      kind: 'unavailable',
      platformCode: 'company_call_limit',
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
    await expect(createTiktokAdapter(config, fakeFetch(json({ code: 36004001, message: 'rt has expired' }))).refreshToken(packed('TTP_r1'))).rejects.toMatchObject({
      kind: 'unauthorized',
      platformCode: '36004001',
    });
    await expect(createTiktokAdapter(config, fakeFetch(json({}, 502))).refreshToken(packed('TTP_r1'))).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it.each([
    ['sai app key', 36009004, 'Invalid credentials. Invalid `app_key` query parameter.'],
    ['sai chữ ký, secret', 106001, 'Invalid credentials. The `sign` query parameter is invalid.'],
    ['mã lạ', 99999999, 'something odd'],
    ['token hết hạn kiểu Open API (không phải lỗi refresh)', 105002, 'Expired credentials.'],
  ])('refresh lỗi %s → rejected giữ mã, không phải unauthorized (không đẩy gian hàng sang needs_reauth)', async (_n, code, message) => {
    await expect(createTiktokAdapter(config, fakeFetch(json({ code, message }))).refreshToken(packed('TTP_r1'))).rejects.toMatchObject({
      kind: 'rejected',
      platformCode: String(code),
    });
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
      ok({ id: '1', main_images: [{ uri: 'tos-1', urls: ['https://img.test/1.jpg', 'https://img.test/1b.jpg'] }], skus: [{ id: '11' }] }),
      ok({ id: '3', main_images: [], skus: [{ id: '31' }] }),
    );
    const skus = await createTiktokAdapter(config, fetchFn).listSkus!(packed());
    expect(skus).toEqual([
      { externalProductId: '1', externalSkuId: '11', sellerSku: 'AO-M', title: 'SP 1', variantLabel: null, imageUrl: 'https://img.test/1.jpg', state: 'live', rejectReason: null, quantity: 7, sellableQuantity: 7 },
      { externalProductId: '3', externalSkuId: '31', sellerSku: 'QUAN-L', title: 'SP 3', variantLabel: null, imageUrl: null, state: 'review', rejectReason: null, quantity: 0, sellableQuantity: 0 },
    ]);
    expect(urlOf(fetchFn, 0).searchParams.has('page_token')).toBe(false);
    expect(urlOf(fetchFn, 1).searchParams.get('page_token')).toBe('p2');
    expect(urlOf(fetchFn, 1).searchParams.get('page_size')).toBe('100');
    expect(initOf(fetchFn, 0).body).toBe('{"status":"ALL"}');
  });

  // Search Products 202502 (OAS của tts-openapi-guide): "Filter products to show only those that are updated on or after the
  // specified date and time. Unix timestamp." `status: ALL` gồm sản phẩm đã xoá.
  it('listSkusChanged (#220 đợt 2): gửi `update_time_ge` (giây) với `status: ALL`, trả cả SKU của sản phẩm đã xoá', async () => {
    const fetchFn = fakeFetch(
      ok({ total_count: 2, next_page_token: '', products: [product('1', 'ACTIVATE', [sku('11', 'AO-M', [2])]), product('2', 'DELETED', [sku('21', 'CU')])] }),
      ok({ id: '1', main_images: [], skus: [{ id: '11' }] }),
    );
    const skus = await createTiktokAdapter(config, fetchFn).listSkusChanged!(packed(), new Date('2026-11-12T01:00:00Z'));
    expect(JSON.parse(String(initOf(fetchFn, 0).body))).toEqual({ status: 'ALL', update_time_ge: 1794445200 });
    expect(skus.map((s) => [s.externalSkuId, s.state])).toEqual([
      ['11', 'live'],
      ['21', 'deleted'],
    ]);
  });

  it('review vòng 2 N1: trang rỗng giữa chừng (token vẫn khác rỗng) mà chưa đủ `total_count` thì rejected `incomplete_list`', async () => {
    const fetchFn = fakeFetch(
      ok({ total_count: 3, next_page_token: 'p2', products: [product('1', 'ACTIVATE', [sku('11', 'A')])] }),
      ok({ total_count: 3, next_page_token: 'p3', products: [] }),
    );
    await expect(createTiktokAdapter(config, fetchFn).listSkus!(packed(), { labels: false })).rejects.toMatchObject({
      kind: 'rejected',
      platformCode: 'incomplete_list',
    });
  });

  it('review vòng 2 N1: sàn trả thành công mà không có mảng `products` thì rejected `unexpected_response`', async () => {
    const fetchFn = fakeFetch(ok({ next_page_token: '' }));
    await expect(createTiktokAdapter(config, fetchFn).listSkus!(packed(), { labels: false })).rejects.toMatchObject({
      kind: 'rejected',
      platformCode: 'unexpected_response',
    });
  });

  it('review vòng 2 N3: SKU của sản phẩm nhiều SKU không đọc được nhãn thì `labelMissing`; một SKU hoặc có nhãn thì không', async () => {
    const fetchFn = fakeFetch(
      ok({ next_page_token: '', products: [product('1', 'ACTIVATE', [sku('11', 'AO-M'), sku('12', 'AO-L')]), product('2', 'ACTIVATE', [sku('21', 'CU')])] }),
    );
    const skus = await createTiktokAdapter(config, fetchFn).listSkus!(packed(), { labels: false });
    expect(skus.map((s) => [s.externalSkuId, s.labelMissing ?? false])).toEqual([
      ['11', true],
      ['12', true],
      ['21', false],
    ]);
  });

  it('listSkus: gian hàng hơn 10000 sản phẩm thì rejected too_many_products, không trả thiếu', async () => {
    const fetchFn = fakeFetch(ok({ total_count: 10001, next_page_token: 'p2', products: [] }));
    await expect(createTiktokAdapter(config, fetchFn).listSkus!(packed())).rejects.toMatchObject({ kind: 'rejected', platformCode: 'too_many_products' });
  });

  it('listSkus (#282): sản phẩm nhiều SKU đọc Get Product, tiêu đề "tên - giá trị thuộc tính"; sản phẩm một SKU giữ tên', async () => {
    const fetchFn = fakeFetch(
      ok({
        next_page_token: '',
        products: [product('1', 'ACTIVATE', [sku('11', 'AO-TRANG-M'), sku('12', 'AO-DEN-L')]), product('2', 'ACTIVATE', [sku('21', 'CU')])],
      }),
      ok({
        id: '1',
        skus: [
          { id: '11', sales_attributes: [{ name: 'Màu', value_name: 'Trắng' }, { name: 'Cỡ', value_name: 'M' }] },
          { id: '12', sales_attributes: [] },
        ],
      }),
      ok({ id: '2', skus: [{ id: '21' }] }),
    );
    const skus = await createTiktokAdapter(config, fetchFn).listSkus!(packed());
    expect(skus.map((s) => [s.externalSkuId, s.title, s.variantLabel])).toEqual([
      ['11', 'SP 1 - Trắng, M', 'Trắng, M'],
      // Không có thuộc tính bán hàng: dùng SKU người bán làm nhãn.
      ['12', 'SP 1 - AO-DEN-L', null],
      ['21', 'SP 2', null],
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(urlOf(fetchFn, 1).pathname).toBe('/product/202309/products/1');
    expect(urlOf(fetchFn, 1).searchParams.get('shop_cipher')).toBe(SHOP.cipher);
  });

  it('listSkus: labels false không gọi Get Product (hoàn tất bằng decisions), nhãn là SKU người bán rồi mã SKU sàn', async () => {
    const fetchFn = fakeFetch(ok({ next_page_token: '', products: [product('1', 'ACTIVATE', [sku('11', 'AO-M'), sku('12', '')])] }));
    const skus = await createTiktokAdapter(config, fetchFn).listSkus!(packed(), { labels: false });
    expect(skus.map((s) => s.title)).toEqual(['SP 1 - AO-M', 'SP 1 - 12']);
    expect(skus.map((s) => s.imageUrl)).toEqual([null, null]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('listSkus: Get Product bị sàn từ chối hay lỗi tạm thì dùng SKU người bán làm nhãn (variantLabel null); mất uỷ quyền thì ném', async () => {
    const page = () => ok({ next_page_token: '', products: [product('1', 'ACTIVATE', [sku('11', 'A'), sku('12', 'B')])] });
    const rejected = json({ code: 12052048, message: 'product not exist', request_id: 'r' });
    const skus = await createTiktokAdapter(config, fakeFetch(page(), rejected)).listSkus!(packed());
    expect(skus.map((s) => s.title)).toEqual(['SP 1 - A', 'SP 1 - B']);
    expect(skus.map((s) => s.variantLabel)).toEqual([null, null]);
    expect(skus.map((s) => s.imageUrl)).toEqual([null, null]);
    const temp = await createTiktokAdapter(config, fakeFetch(page(), json({}, 503))).listSkus!(packed());
    expect(temp.map((s) => s.title)).toEqual(['SP 1 - A', 'SP 1 - B']);
    const unauthorized = json({ code: 105002, message: 'Expired credentials', request_id: 'r' });
    await expect(createTiktokAdapter(config, fakeFetch(page(), unauthorized)).listSkus!(packed())).rejects.toMatchObject({ kind: 'unauthorized' });
  });

  describe('listSkus: lỗi khi đọc nhãn (review chéo I-3)', () => {
    const three = ['1', '2', '3'].map((id) => product(id, 'ACTIVATE', [sku(`${id}1`, `S${id}A`), sku(`${id}2`, `S${id}B`)]));
    const err = (code: number) => json({ code, message: 'lỗi', request_id: 'r' });
    const detail = (id: string) => ok({ skus: [{ id: `${id}1`, sales_attributes: [{ value_name: 'Đỏ' }] }] });
    const run = async (...details: Response[]) => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const fetchFn = fakeFetch(ok({ next_page_token: '', products: three }), ...details);
      const skus = await createTiktokAdapter(config, fetchFn).listSkus!(packed());
      const logged = warn.mock.calls.map((c) => c[0]);
      warn.mockRestore();
      const called = fetchFn.mock.calls.slice(1).map(([u]) => new URL(String(u)).pathname.split('/').pop());
      return { skus, called, logged };
    };

    it('lỗi của một sản phẩm: bỏ qua, đọc tiếp sản phẩm sau, ghi một dòng log tổng', async () => {
      const { skus, called, logged } = await run(err(12052048), detail('2'), detail('3'));
      expect(called).toEqual(['1', '2', '3']);
      expect(skus.find((s) => s.externalSkuId === '21')?.variantLabel).toBe('Đỏ');
      expect(logged).toEqual([expect.objectContaining({ externalShopId: SHOP.id, failed: 1, codes: { '12052048': 1 }, stoppedBy: null })]);
    });

    // Năm lời gọi chạy cùng lúc: lỗi chung chặn các lời gọi chưa bắt đầu, lời gọi đang chạy vẫn chạy nốt.
    const eight = Array.from({ length: 8 }, (_, i) => product(`${i + 1}`, 'ACTIVATE', [sku(`${i + 1}1`, `S${i + 1}A`), sku(`${i + 1}2`, `S${i + 1}B`)]));
    const runEight = async (detail: (id: string) => Response) => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const fetchFn = vi.fn<typeof fetch>(async (url) => {
        const u = new URL(String(url));
        return u.pathname.endsWith('/search') ? ok({ next_page_token: '', products: eight }) : detail(u.pathname.split('/').pop()!);
      });
      await createTiktokAdapter(config, fetchFn).listSkus!(packed());
      const logged = warn.mock.calls.map((c) => c[0]);
      warn.mockRestore();
      return { called: fetchFn.mock.calls.length - 1, logged };
    };

    it('thiếu scope (105005) hay sàn lỗi tạm: không gọi thêm sản phẩm nào sau lời gọi đang chạy', async () => {
      const scope = await runEight((id) => (id === '1' ? err(105005) : detail(id)));
      expect(scope.called).toBe(5);
      expect(scope.logged).toEqual([expect.objectContaining({ failed: 1, stoppedBy: '105005' })]);
      const temp = await runEight(() => json({}, 503));
      expect(temp.called).toBe(5);
      expect(temp.logged).toEqual([expect.objectContaining({ stoppedBy: 'http_503' })]);
    });

    it('cùng một mã hai lần liền: dừng; log không chứa token, cipher', async () => {
      const { called, logged } = await runEight(() => err(12000001));
      // Lỗi đầu chưa dừng nên một lời gọi kịp bắt sản phẩm thứ 6; lỗi thứ hai về thì không gọi thêm.
      expect(called).toBe(6);
      expect(logged).toEqual([expect.objectContaining({ stoppedBy: '12000001' })]);
      expect(JSON.stringify(logged)).not.toMatch(new RegExp(`${SHOP.cipher}|TTP_at|tts1\\.`));
    });

    it('không gọi Get Product cho sản phẩm FREEZE (Get Product không trả)', async () => {
      const fetchFn = fakeFetch(ok({ next_page_token: '', products: [product('9', 'FREEZE', [sku('91', 'F1'), sku('92', 'F2')])] }));
      const skus = await createTiktokAdapter(config, fetchFn).listSkus!(packed());
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(skus.map((s) => s.title)).toEqual(['SP 9 - F1', 'SP 9 - F2']);
    });
  });

  it('listSkus (#282): imageUrl là main_images[0].urls[0] của Get Product, cả sản phẩm một SKU; đọc sản phẩm nhiều SKU trước', async () => {
    const fetchFn = fakeFetch(
      ok({
        next_page_token: '',
        products: [product('1', 'ACTIVATE', [sku('11', 'A')]), product('2', 'SELLER_DEACTIVATED', [sku('21', 'B1'), sku('22', 'B2')]), product('3', 'FREEZE', [sku('31', 'C')])],
      }),
      ok({ id: '2', main_images: [{ uri: 'u2', urls: ['https://img.test/2.jpg'] }], skus: [{ id: '21', sales_attributes: [{ value_name: 'Đỏ' }] }] }),
      ok({ id: '1', main_images: [{ uri: 'u1', urls: [] }, { uri: 'u1b', urls: ['https://img.test/1b.jpg'] }], skus: [{ id: '11' }] }),
    );
    const skus = await createTiktokAdapter(config, fetchFn).listSkus!(packed());
    expect(fetchFn.mock.calls.slice(1).map(([u]) => new URL(String(u)).pathname.split('/').pop())).toEqual(['2', '1']);
    expect(skus.map((s) => [s.externalSkuId, s.imageUrl, s.state])).toEqual([
      // Ảnh đầu không có URL: không lấy ảnh sau (FE hiện ô trống).
      ['11', null, 'live'],
      ['21', 'https://img.test/2.jpg', 'inactive'],
      ['22', 'https://img.test/2.jpg', 'inactive'],
      // FREEZE: Get Product không trả, không gọi, không ảnh.
      ['31', null, 'hold'],
    ]);
  });

  it('listSkus: đọc chi tiết tối đa 50 sản phẩm, nhiều SKU trước rồi một SKU; phần còn lại không ảnh', async () => {
    const single = Array.from({ length: 30 }, (_, i) => product(`s${i}`, 'ACTIVATE', [sku(`s${i}a`, `SS${i}`)]));
    const multi = Array.from({ length: 30 }, (_, i) => product(`m${i}`, 'ACTIVATE', [sku(`m${i}a`, `M${i}A`), sku(`m${i}b`, `M${i}B`)]));
    const fetchFn = vi.fn<typeof fetch>(async (url) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith('/search')) return ok({ next_page_token: '', products: [...single, ...multi] });
      const id = u.pathname.split('/').pop()!;
      return ok({ main_images: [{ urls: [`https://img.test/${id}.jpg`] }], skus: [] });
    });
    const skus = await createTiktokAdapter(config, fetchFn).listSkus!(packed());
    expect(fetchFn).toHaveBeenCalledTimes(51);
    expect(skus.find((s) => s.externalSkuId === 'm29a')!.imageUrl).toBe('https://img.test/m29.jpg');
    expect(skus.find((s) => s.externalSkuId === 's19a')!.imageUrl).toBe('https://img.test/s19.jpg');
    expect(skus.find((s) => s.externalSkuId === 's20a')!.imageUrl).toBeNull();
  });

  it('listSkus: đọc nhãn tối đa 50 sản phẩm nhiều SKU, phần còn lại nhãn là SKU người bán', async () => {
    const products = Array.from({ length: 52 }, (_, i) => product(`p${i}`, 'ACTIVATE', [sku(`${i}a`, `S${i}A`), sku(`${i}b`, `S${i}B`)]));
    const fetchFn = vi.fn<typeof fetch>(async (url) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith('/search')) return ok({ next_page_token: '', products });
      const id = u.pathname.split('/').pop()!.slice(1);
      return ok({ skus: [{ id: `${id}a`, sales_attributes: [{ value_name: 'X' }] }] });
    });
    const skus = await createTiktokAdapter(config, fetchFn).listSkus!(packed());
    expect(fetchFn).toHaveBeenCalledTimes(51);
    expect(skus.find((s) => s.externalSkuId === '49a')!.title).toBe('SP p49 - X');
    expect(skus.find((s) => s.externalSkuId === '50a')!.title).toBe('SP p50 - S50A');
  });

  it('listSkus: sản phẩm mà mọi SKU nằm trong skipSellerSkus không đọc chi tiết và không tiêu trần 50', async () => {
    const matched = Array.from({ length: 60 }, (_, i) => product(`k${i}`, 'ACTIVATE', [sku(`k${i}a`, `K${i}A`), sku(`k${i}b`, `K${i}B`)]));
    // Một SKU ghép được, một SKU không: vẫn phải đọc nhãn.
    const half = product('h', 'ACTIVATE', [sku('ha', 'K0A'), sku('hb', 'LA')]);
    const fetchFn = vi.fn<typeof fetch>(async (url) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith('/search')) return ok({ next_page_token: '', products: [...matched, half] });
      return ok({ skus: [{ id: 'hb', sales_attributes: [{ value_name: 'Lạ' }] }] });
    });
    const skip = new Set(Array.from({ length: 60 }, (_, i) => [`K${i}A`, `K${i}B`]).flat());
    const skus = await createTiktokAdapter(config, fetchFn).listSkus!(packed(), { skipSellerSkus: skip });
    expect(fetchFn.mock.calls.slice(1).map(([u]) => new URL(String(u)).pathname.split('/').pop())).toEqual(['h']);
    expect(skus.find((s) => s.externalSkuId === 'hb')!.variantLabel).toBe('Lạ');
    expect(skus.find((s) => s.externalSkuId === 'k0a')!.imageUrl).toBeNull();
  });

  it('listSkus: mở lại không gọi Get Product cho sản phẩm cùng update_time; update_time đổi thì đọc lại', async () => {
    let updateTime = 100;
    const fetchFn = vi.fn<typeof fetch>(async (url) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith('/search')) {
        return ok({ next_page_token: '', products: [{ ...product('1', 'ACTIVATE', [sku('11', 'A'), sku('12', 'B')]), update_time: updateTime }] });
      }
      return ok({ main_images: [{ urls: ['https://img.test/1.jpg'] }], skus: [{ id: '11', sales_attributes: [{ value_name: 'Đỏ' }] }] });
    });
    const adapter = createTiktokAdapter(config, fetchFn);
    await adapter.listSkus!(packed());
    const again = await adapter.listSkus!(packed());
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(again.find((s) => s.externalSkuId === '11')).toMatchObject({ variantLabel: 'Đỏ', imageUrl: 'https://img.test/1.jpg' });
    updateTime = 200;
    await adapter.listSkus!(packed());
    expect(fetchFn).toHaveBeenCalledTimes(5);
  });

  it('listSkus: sàn trả lại con trỏ trang vừa gửi thì rejected page_token_repeated, không trả thiếu', async () => {
    const fetchFn = fakeFetch(
      ok({ next_page_token: 'p2', products: [product('1', 'ACTIVATE', [sku('11', 'A')])] }),
      ok({ next_page_token: 'p2', products: [product('2', 'ACTIVATE', [sku('21', 'B')])] }),
    );
    await expect(createTiktokAdapter(config, fetchFn).listSkus!(packed(), { labels: false })).rejects.toMatchObject({
      kind: 'rejected',
      platformCode: 'page_token_repeated',
    });
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

  // Năng lực tồn giá, ẩn hiện, đăng sản phẩm (#226, #219) test ở `tiktok-listing.test.ts`.
  it('đẩy lô rỗng không gọi sàn', async () => {
    const fetchFn = fakeFetch();
    expect(await createTiktokAdapter(config, fetchFn).updatePriceQuantity(packed(), [])).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
