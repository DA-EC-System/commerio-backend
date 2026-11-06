// Adapter TikTok phần tồn, giá, ẩn hiện (#226) và đăng sản phẩm (#219) với sàn giả theo đường dẫn API. Dạng request và
// phản hồi theo docv2 (tra 07/11/2026): update-inventory-202309, update-price-202309, deactivate-products-202309,
// activate-products-202309, get-warehouse-list-202309, get-categories-202309, get-category-attributes-202309,
// upload-product-image-202309, create-product-202309; lỗi theo gọi thật trên shop thử 07/11/2026.
import { describe, expect, it, vi } from 'vitest';
import { MarketplaceError, type PriceQuantity } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { createTiktokClient, packTiktokToken, signTiktok } from '#src/modules/channel/channel/service/marketplaces/tiktok-client.ts';
import { isPrivateAddress, tiktokListingMethods } from '#src/modules/channel/channel/service/marketplaces/tiktok-listing.ts';
import { createTiktokAdapter } from '#src/modules/channel/channel/service/marketplaces/tiktok.ts';

const config = { appKey: 'appk', appSecret: 'apps', serviceId: undefined, apiUrl: 'https://open.test', authUrl: 'https://auth.test' };
const TOKEN = packTiktokToken({ token: 'TTP_at', cipher: 'ROW_c', shopId: '749' });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ok = (data: unknown) => json({ code: 0, message: 'Success', request_id: 'r', data });
const fail = (code: number, message: string) => json({ code, message, request_id: 'r', data: null });

const WAREHOUSES = {
  warehouses: [
    { id: 'RET', type: 'RETURN_WAREHOUSE', is_default: false, effect_status: 'ENABLED' },
    { id: 'W1', type: 'SALES_WAREHOUSE', is_default: true, effect_status: 'ENABLED' },
  ],
};

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}

/** Sàn giả: `routes` khoá `METHOD path`, trả Response hoặc hàm theo body; ghi lại mọi lời gọi. */
function fakeSan(routes: Record<string, Response | ((body: unknown) => Response)>) {
  const calls: Call[] = [];
  const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
    const u = new URL(String(input));
    const raw = init?.body;
    const body = typeof raw === 'string' ? JSON.parse(raw) : raw;
    calls.push({ method: init?.method ?? 'GET', path: u.pathname, query: u.searchParams, headers: (init?.headers ?? {}) as Record<string, string>, body });
    const r = routes[`${init?.method ?? 'GET'} ${u.pathname}`];
    if (!r) return json({ code: 36009009, message: 'Invalid path' });
    return typeof r === 'function' ? r(body) : r.clone();
  });
  return { fetchFn, calls, methods: (deps = {}) => tiktokListingMethods(createTiktokClient(config, fetchFn), deps) };
}

const item = (productId: string, skuId: string, extra: Partial<PriceQuantity>): PriceQuantity => ({ externalProductId: productId, externalSkuId: skuId, ...extra });

describe('updatePriceQuantity', () => {
  it('gom theo sản phẩm: tồn vào kho bán mặc định, giá VND; kho đọc một lần cho nhiều lượt', async () => {
    const san = fakeSan({
      'GET /logistics/202309/warehouses': ok(WAREHOUSES),
      'POST /product/202309/products/P1/inventory/update': ok({}),
      'POST /product/202309/products/P1/prices/update': ok({}),
      'POST /product/202309/products/P2/inventory/update': ok({}),
    });
    const m = san.methods();
    const result = await m.updatePriceQuantity(TOKEN, [
      item('P1', 'S1', { quantity: 0, price: '61000' }),
      item('P2', 'S3', { quantity: 7 }),
      item('P1', 'S2', { quantity: 4 }),
    ]);
    expect(result).toEqual([
      { externalSkuId: 'S1', ok: true },
      { externalSkuId: 'S3', ok: true },
      { externalSkuId: 'S2', ok: true },
    ]);
    const inv = san.calls.find((c) => c.path === '/product/202309/products/P1/inventory/update')!;
    expect(inv.body).toEqual({
      skus: [
        { id: 'S1', inventory: [{ warehouse_id: 'W1', quantity: 0 }] },
        { id: 'S2', inventory: [{ warehouse_id: 'W1', quantity: 4 }] },
      ],
    });
    expect(inv.query.get('shop_cipher')).toBe('ROW_c');
    expect(san.calls.find((c) => c.path.endsWith('/P1/prices/update'))!.body).toEqual({ skus: [{ id: 'S1', price: { amount: '61000', currency: 'VND' } }] });
    // P2 chỉ có tồn: không gọi giá.
    expect(san.calls.some((c) => c.path.endsWith('/P2/prices/update'))).toBe(false);
    await m.updatePriceQuantity(TOKEN, [item('P2', 'S3', { quantity: 1 })]);
    expect(san.calls.filter((c) => c.path === '/logistics/202309/warehouses')).toHaveLength(1);
  });

  it('lỗi từng SKU trong data.errors (code 0) chỉ đánh lỗi SKU đó, lấy mã của lỗi phụ', async () => {
    const san = fakeSan({
      'GET /logistics/202309/warehouses': ok(WAREHOUSES),
      'POST /product/202309/products/P1/inventory/update': ok({
        errors: [
          {
            code: 12052990,
            message: 'Batch update inventory error.',
            detail: { sku_id: 'S2', extra_errors: [{ warehouse_id: 'W1', code: 12052097, message: 'The warehouse does not exist' }] },
          },
        ],
      }),
    });
    const result = await san.methods().updatePriceQuantity(TOKEN, [item('P1', 'S1', { quantity: 1 }), item('P1', 'S2', { quantity: 2 })]);
    expect(result).toEqual([
      { externalSkuId: 'S1', ok: true },
      { externalSkuId: 'S2', ok: false, code: '12052097', message: 'The warehouse does not exist' },
    ]);
  });

  it('sàn từ chối cả lời gọi nhiều SKU (một mã SKU sai): gọi lại từng SKU, chỉ SKU sai lỗi', async () => {
    const san = fakeSan({
      'GET /logistics/202309/warehouses': ok(WAREHOUSES),
      'POST /product/202309/products/P1/inventory/update': (body) => {
        const ids = (body as { skus: { id: string }[] }).skus.map((s) => s.id);
        return ids.includes('BAD') ? fail(12052556, 'Resource Not Found. No `sku` matches `BAD`.') : ok({});
      },
    });
    const result = await san.methods().updatePriceQuantity(TOKEN, [item('P1', 'S1', { quantity: 1 }), item('P1', 'BAD', { quantity: 2 })]);
    expect(result).toEqual([
      { externalSkuId: 'S1', ok: true },
      { externalSkuId: 'BAD', ok: false, code: '12052556', message: 'Resource Not Found. No `sku` matches `BAD`.' },
    ]);
    expect(san.calls.filter((c) => c.path.endsWith('/inventory/update'))).toHaveLength(3);
  });

  it('giá bị từ chối (khuyến mãi khoá giá) thì SKU lỗi dù tồn đã đẩy; sản phẩm khác vẫn đẩy', async () => {
    const san = fakeSan({
      'GET /logistics/202309/warehouses': ok(WAREHOUSES),
      'POST /product/202309/products/P1/inventory/update': ok({}),
      'POST /product/202309/products/P1/prices/update': fail(12052038, 'Product price locked due to ongoing promotion.'),
      'POST /product/202309/products/P2/inventory/update': ok({}),
    });
    const result = await san.methods().updatePriceQuantity(TOKEN, [item('P1', 'S1', { quantity: 1, price: '1000' }), item('P2', 'S2', { quantity: 3 })]);
    expect(result).toEqual([
      { externalSkuId: 'S1', ok: false, code: '12052038', message: 'Product price locked due to ongoing promotion.' },
      { externalSkuId: 'S2', ok: true },
    ]);
  });

  it('sàn lỗi tạm: SKU của sản phẩm đó lỗi, không ném', async () => {
    const san = fakeSan({ 'GET /logistics/202309/warehouses': ok(WAREHOUSES), 'POST /product/202309/products/P1/inventory/update': json({}, 503) });
    const [r] = await san.methods().updatePriceQuantity(TOKEN, [item('P1', 'S1', { quantity: 1 }), item('P1', 'S2', { quantity: 2 })]);
    expect(r).toEqual({ externalSkuId: 'S1', ok: false, code: 'http_503', message: 'Sàn lỗi tạm' });
    // Lỗi tạm không gọi lại từng SKU.
    expect(san.calls.filter((c) => c.path.endsWith('/inventory/update'))).toHaveLength(1);
  });

  it('token sai thì ném unauthorized', async () => {
    const san = fakeSan({ 'GET /logistics/202309/warehouses': fail(105002, 'Expired credentials') });
    await expect(san.methods().updatePriceQuantity(TOKEN, [item('P1', 'S1', { quantity: 1 })])).rejects.toMatchObject({ kind: 'unauthorized' });
    const san2 = fakeSan({ 'POST /product/202309/products/P1/prices/update': fail(105002, 'Expired credentials') });
    await expect(san2.methods().updatePriceQuantity(TOKEN, [item('P1', 'S1', { price: '1' })])).rejects.toMatchObject({ kind: 'unauthorized' });
  });

  it('gian hàng không có kho bán: tồn lỗi no_warehouse theo SKU, giá vẫn đẩy; lỗi kho không giữ trong bộ nhớ', async () => {
    const san = fakeSan({
      'GET /logistics/202309/warehouses': ok({ warehouses: [{ id: 'RET', type: 'RETURN_WAREHOUSE' }] }),
      'POST /product/202309/products/P1/prices/update': ok({}),
    });
    const m = san.methods();
    expect(await m.updatePriceQuantity(TOKEN, [item('P1', 'S1', { quantity: 1, price: '5' }), item('P1', 'S2', { price: '6' })])).toEqual([
      { externalSkuId: 'S1', ok: false, code: 'no_warehouse', message: 'Gian hàng TikTok chưa có kho bán hàng' },
      { externalSkuId: 'S2', ok: true },
    ]);
    await m.updatePriceQuantity(TOKEN, [item('P1', 'S1', { quantity: 1 })]);
    expect(san.calls.filter((c) => c.path === '/logistics/202309/warehouses')).toHaveLength(2);
  });
});

describe('deactivate, activate', () => {
  it('gửi product_ids của sản phẩm; data.errors thì ném rejected giữ mã', async () => {
    const san = fakeSan({
      'POST /product/202309/products/deactivate': ok({}),
      'POST /product/202309/products/activate': ok({
        errors: [{ code: 12052990, message: 'Batch activate business error.', detail: { product_id: 'P1', extra_errors: [{ code: 12052048, message: "You can't edit other sellers' products" }] } }],
      }),
    });
    const m = san.methods();
    await m.deactivate(TOKEN, 'P1', 'S1');
    expect(san.calls[0]).toMatchObject({ method: 'POST', path: '/product/202309/products/deactivate', body: { product_ids: ['P1'] } });
    await expect(m.activate!(TOKEN, 'P1', 'S1')).rejects.toMatchObject({ kind: 'rejected', platformCode: '12052048' });
  });

  it.each([
    ['deactivate', 'SELLER_DEACTIVATED', true],
    ['deactivate', 'ACTIVATE', false],
    ['activate', 'PENDING', true],
    ['activate', 'ACTIVATE', true],
    ['activate', 'SELLER_DEACTIVATED', false],
  ] as const)('%s gặp 12052901 khi sản phẩm %s: xong = %s', async (action, status, done) => {
    const san = fakeSan({
      [`POST /product/202309/products/${action}`]: ok({ errors: [{ code: 12052901, message: 'product status invalid', detail: { product_id: 'P1' } }] }),
      'GET /product/202309/products/P1': ok({ id: 'P1', status }),
    });
    const p = san.methods()[action]!(TOKEN, 'P1', 'S1');
    if (done) await expect(p).resolves.toBeUndefined();
    else await expect(p).rejects.toMatchObject({ kind: 'rejected', platformCode: '12052901' });
  });
});

describe('danh mục', () => {
  it('listCategories: chỉ lá AVAILABLE, tên là đường dẫn từ gốc, cây v2', async () => {
    const san = fakeSan({
      'GET /product/202309/categories': ok({
        categories: [
          { id: '1', parent_id: '0', local_name: 'Đồ dùng nhà bếp', is_leaf: false, permission_statuses: ['AVAILABLE'] },
          { id: '2', parent_id: '1', local_name: 'Đồ dùng uống nước', is_leaf: false, permission_statuses: ['AVAILABLE'] },
          { id: '3', parent_id: '2', local_name: 'Cốc có quai', is_leaf: true, permission_statuses: ['AVAILABLE'] },
          { id: '4', parent_id: '2', local_name: 'Bình', is_leaf: true, permission_statuses: ['INVITE_ONLY'] },
          { id: '5', parent_id: '0', local_name: 'Khác', is_leaf: true },
        ],
      }),
    });
    expect(await san.methods().listCategories(TOKEN)).toEqual([
      { externalId: '3', name: 'Đồ dùng nhà bếp > Đồ dùng uống nước > Cốc có quai' },
      { externalId: '5', name: 'Khác' },
    ]);
    expect(san.calls[0]!.query.get('category_version')).toBe('v2');
  });

  it('categoryAttributes: chỉ thuộc tính sản phẩm luôn bắt buộc; name là mã; cho tự nhập thì options rỗng', async () => {
    const san = fakeSan({
      'GET /product/202309/categories/600042/attributes': ok({
        attributes: [
          { id: '100149', name: 'Quốc gia xuất xứ', type: 'PRODUCT_PROPERTY', is_requried: true, is_customizable: true, values: [{ id: '1000854', name: 'Việt Nam' }] },
          { id: '100200', name: 'Chất liệu', type: 'PRODUCT_PROPERTY', is_requried: true, is_customizable: false, values: [{ id: '9', name: 'Sứ' }] },
          { id: '100300', name: 'Dịp', type: 'PRODUCT_PROPERTY', is_requried: false, values: [] },
          { id: '100000', name: 'Màu', type: 'SALES_PROPERTY', values: [] },
        ],
      }),
    });
    expect(await san.methods().categoryAttributes(TOKEN, '600042')).toEqual([
      { name: '100149', label: 'Quốc gia xuất xứ', options: [] },
      { name: '100200', label: 'Chất liệu', options: ['Sứ'] },
    ]);
  });
});

describe('uploadImage', () => {
  const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const image = (type = 'image/png') => new Response(PNG, { status: 200, headers: { 'content-type': type } });
  const publicHost = async () => ['93.184.216.34'];

  it('tải ảnh nguồn rồi đưa lên bằng multipart: không ký body, không gửi shop_cipher, trả uri', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    try {
      const san = fakeSan({ 'POST /product/202309/images/upload': ok({ uri: 'tos-alisg/abc', url: 'https://p16/abc' }) });
      const fetchImage = vi.fn<typeof fetch>(async () => image());
      const uri = await san.methods({ fetchImage, resolveHost: publicHost }).uploadImage(TOKEN, 'https://cdn.example.vn/anh/coc.png');
      expect(uri).toBe('tos-alisg/abc');
      const call = san.calls[0]!;
      expect(call.body).toBeInstanceOf(FormData);
      const form = call.body as FormData;
      expect(form.get('use_case')).toBe('MAIN_IMAGE');
      const file = form.get('data') as File;
      expect(file.name).toBe('coc.png');
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG);
      // fetch tự đặt content-type kèm boundary; token ở header.
      expect(call.headers).toEqual({ 'x-tts-access-token': 'TTP_at' });
      expect(call.query.has('shop_cipher')).toBe(false);
      const query = Object.fromEntries([...call.query].filter(([k]) => k !== 'sign'));
      expect(call.query.get('sign')).toBe(signTiktok('/product/202309/images/upload', query, '', 'apps'));
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['giao thức file', 'file:///etc/passwd', ['93.184.216.34']],
    ['host phân giải ra mạng riêng', 'https://noi-bo.example/a.png', ['10.0.0.5']],
    ['IP loopback trên URL', 'http://127.0.0.1:3000/a.png', []],
    ['IPv6 link-local', 'http://[fe80::1]/a.png', []],
    ['không phân giải được', 'https://khong-co.example/a.png', []],
  ])('%s → rejected image_source_invalid, không tải', async (_name, url, addrs) => {
    const san = fakeSan({});
    const fetchImage = vi.fn<typeof fetch>(async () => image());
    const err = await san
      .methods({ fetchImage, resolveHost: async () => addrs })
      .uploadImage(TOKEN, url)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'rejected', platformCode: 'image_source_invalid' });
    expect(fetchImage).not.toHaveBeenCalled();
    expect(san.fetchFn).not.toHaveBeenCalled();
  });

  it('chuyển hướng sang địa chỉ nội bộ bị chặn; không phải ảnh bị chặn', async () => {
    const resolveHost = async (host: string) => (host === 'cdn.example.vn' ? ['93.184.216.34'] : ['192.168.1.2']);
    const redirect = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { location: 'http://router.lan/a.png' } }));
    await expect(fakeSan({}).methods({ fetchImage: redirect, resolveHost }).uploadImage(TOKEN, 'https://cdn.example.vn/a.png')).rejects.toMatchObject({
      platformCode: 'image_source_invalid',
    });
    expect(redirect).toHaveBeenCalledTimes(1);
    const html = vi.fn<typeof fetch>(async () => image('text/html'));
    await expect(fakeSan({}).methods({ fetchImage: html, resolveHost }).uploadImage(TOKEN, 'https://cdn.example.vn/a.png')).rejects.toMatchObject({
      platformCode: 'image_source_invalid',
    });
  });

  it('isPrivateAddress', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', '::ffff:10.0.0.1', 'khong-phai-ip']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['93.184.216.34', '172.32.0.1', '2001:4860::8888']) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

describe('createProduct', () => {
  const product = {
    externalCategoryId: '600042',
    attributes: { '100149': 'Việt Nam', '101489': 'Nhóm đồ án <Commerio>' },
    name: 'CM-TEST Cốc sứ có quai 350ml thử API',
    description: 'Cốc thử <không bán> & không giao',
    imageUrls: ['tos-alisg/abc'],
    sellerSku: 'CM-TEST-COC',
    price: '99000',
    quantity: 5,
    weightG: 300,
    lengthMm: 95,
    widthMm: 100,
    heightMm: 120,
  };
  const routes = (status: Response) => ({
    'GET /logistics/202309/warehouses': ok(WAREHOUSES),
    'GET /product/202309/categories/600042/attributes': ok({
      attributes: [{ id: '100149', name: 'Quốc gia xuất xứ', type: 'PRODUCT_PROPERTY', values: [{ id: '1000854', name: 'Việt Nam' }] }],
    }),
    'POST /product/202309/products': ok({ product_id: 'P9', skus: [{ id: 'S9', seller_sku: 'CM-TEST-COC' }] }),
    'GET /product/202309/products/P9': status,
  });

  it('gửi đúng trường của docv2: kho mặc định, VND, kg, cm, v2, thuộc tính theo mã lựa chọn hoặc tên tự nhập', async () => {
    const san = fakeSan(routes(ok({ id: 'P9', status: 'PENDING' })));
    expect(await san.methods().createProduct(TOKEN, product)).toEqual({ externalProductId: 'P9', externalSkuId: 'S9', live: false });
    expect(san.calls.find((c) => c.method === 'POST' && c.path === '/product/202309/products')!.body).toEqual({
      save_mode: 'LISTING',
      title: product.name,
      description: '<p>Cốc thử &lt;không bán&gt; &amp; không giao</p>',
      category_id: '600042',
      category_version: 'v2',
      main_images: [{ uri: 'tos-alisg/abc' }],
      package_weight: { value: '0.3', unit: 'KILOGRAM' },
      package_dimensions: { length: '10', width: '10', height: '12', unit: 'CENTIMETER' },
      product_attributes: [
        { id: '100149', values: [{ id: '1000854' }] },
        { id: '101489', values: [{ name: 'Nhóm đồ án <Commerio>' }] },
      ],
      skus: [{ seller_sku: 'CM-TEST-COC', price: { amount: '99000', currency: 'VND' }, inventory: [{ warehouse_id: 'W1', quantity: 5 }] }],
    });
  });

  it('live theo trạng thái đọc lại; đọc lỗi tạm thì coi như chờ duyệt; tồn 0 thì bỏ quantity', async () => {
    expect((await fakeSan(routes(ok({ status: 'ACTIVATE' }))).methods().createProduct(TOKEN, product)).live).toBe(true);
    const san = fakeSan(routes(json({}, 503)));
    expect(await san.methods().createProduct(TOKEN, { ...product, quantity: 0 })).toMatchObject({ externalProductId: 'P9', live: false });
    const body = san.calls.find((c) => c.method === 'POST' && c.path === '/product/202309/products')!.body as { skus: { inventory: unknown[] }[] };
    expect(body.skus[0]!.inventory).toEqual([{ warehouse_id: 'W1' }]);
  });

  it('sàn từ chối thì ném rejected giữ mã; phản hồi thiếu mã thì unexpected_response', async () => {
    const bad = fakeSan({ ...routes(ok({})), 'POST /product/202309/products': fail(12052217, 'All region shops must use V2 categories.') });
    await expect(bad.methods().createProduct(TOKEN, product)).rejects.toMatchObject({ kind: 'rejected', platformCode: '12052217' });
    const odd = fakeSan({ ...routes(ok({})), 'POST /product/202309/products': ok({ product_id: 'P9' }) });
    const err = await odd
      .methods()
      .createProduct(TOKEN, product)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarketplaceError);
    expect(err).toMatchObject({ platformCode: 'unexpected_response' });
  });
});

it('adapter TikTok có đủ năng lực listing (không còn unsupported), kể cả activate', () => {
  const adapter = createTiktokAdapter(config, vi.fn<typeof fetch>());
  for (const k of ['listCategories', 'categoryAttributes', 'uploadImage', 'createProduct', 'updatePriceQuantity', 'deactivate', 'activate'] as const) {
    expect(typeof adapter[k]).toBe('function');
  }
  expect(adapter.capabilities.hideBy).toBe('deactivate');
});
