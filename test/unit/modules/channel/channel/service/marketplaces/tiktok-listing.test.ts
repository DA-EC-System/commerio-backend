// Adapter TikTok phần tồn, giá, ẩn hiện (#226) và đăng sản phẩm (#219) với sàn giả theo đường dẫn API. Dạng request và
// phản hồi theo docv2 (tra 07/11/2026): update-inventory-202309, update-price-202309, deactivate-products-202309,
// activate-products-202309, get-warehouse-list-202309, get-categories-202309, get-category-attributes-202309,
// upload-product-image-202309, create-product-202309; lỗi theo gọi thật trên shop thử 07/11/2026.
import { describe, expect, it, vi } from 'vitest';
import { MarketplaceError, type PriceQuantity } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { createTiktokClient, packTiktokToken } from '#src/modules/channel/channel/service/marketplaces/tiktok-client.ts';
import { isPrivateAddress, tiktokListingMethods } from '#src/modules/channel/channel/service/marketplaces/tiktok-listing.ts';
import { createTiktokAdapter, tiktokAuditReason } from '#src/modules/channel/channel/service/marketplaces/tiktok.ts';

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
    expect(result).toMatchObject([
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
    expect(result).toMatchObject([
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
    expect(result).toMatchObject([
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
    // 12052038 là khuyến mãi khoá giá (docv2 update-price-202309): đổi thành `promotion_locked`, giữ câu của sàn (#223).
    expect(result).toMatchObject([
      { externalSkuId: 'S1', ok: false, code: 'promotion_locked', message: 'Product price locked due to ongoing promotion.' },
      { externalSkuId: 'S2', ok: true },
    ]);
    // Kết quả riêng từng phần (#223 review 3): tồn của S1 đã lên sàn, chỉ giá lỗi.
    expect(result[0]).toMatchObject({ stock: { ok: true }, price: { ok: false, code: 'promotion_locked' } });
    expect(result[1]).toEqual({ externalSkuId: 'S2', ok: true, stock: { ok: true } });
  });

  it('mã khoá do khuyến mãi của tồn (12052393, 12052165) và giá (12019045) → promotion_locked; mã khác giữ nguyên', async () => {
    const lockedStock = 'Product locked for Promotion and stock can\'t be updated below current stock';
    const san = fakeSan({
      'GET /logistics/202309/warehouses': ok(WAREHOUSES),
      'POST /product/202309/products/P1/inventory/update': ok({
        errors: [
          { code: 12052393, message: lockedStock, detail: { sku_id: 'S1' } },
          { code: 12052165, message: 'insufficient inventory to cover campaign reservations', detail: { sku_id: 'S2' } },
          { code: 12052097, message: 'The warehouse does not exist', detail: { sku_id: 'S3' } },
        ],
      }),
      'POST /product/202309/products/P2/prices/update': fail(12019045, 'price is locked'),
    });
    const result = await san.methods().updatePriceQuantity(TOKEN, [
      item('P1', 'S1', { quantity: 1 }),
      item('P1', 'S2', { quantity: 1 }),
      item('P1', 'S3', { quantity: 1 }),
      item('P2', 'S4', { price: '1000' }),
    ]);
    expect(result).toMatchObject([
      { externalSkuId: 'S1', ok: false, code: 'promotion_locked', message: lockedStock },
      { externalSkuId: 'S2', ok: false, code: 'promotion_locked', message: 'insufficient inventory to cover campaign reservations' },
      { externalSkuId: 'S3', ok: false, code: '12052097', message: 'The warehouse does not exist' },
      { externalSkuId: 'S4', ok: false, code: 'promotion_locked', message: 'price is locked' },
    ]);
  });

  it('sàn lỗi tạm: SKU của sản phẩm đó lỗi, không ném', async () => {
    const san = fakeSan({ 'GET /logistics/202309/warehouses': ok(WAREHOUSES), 'POST /product/202309/products/P1/inventory/update': json({}, 503) });
    const [r] = await san.methods().updatePriceQuantity(TOKEN, [item('P1', 'S1', { quantity: 1 }), item('P1', 'S2', { quantity: 2 })]);
    expect(r).toMatchObject({ externalSkuId: 'S1', ok: false, code: 'http_503', message: 'Sàn lỗi tạm' });
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
    expect(await m.updatePriceQuantity(TOKEN, [item('P1', 'S1', { quantity: 1, price: '5' }), item('P1', 'S2', { price: '6' })])).toMatchObject([
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

describe('uploadImage: chặn nguồn ảnh trước khi nối (tải thật qua server cục bộ ở test/integration/channel/channel/image-source.test.ts)', () => {
  it.each([
    ['giao thức file', 'file:///etc/passwd', ['93.184.216.34']],
    ['host phân giải ra mạng riêng', 'https://noi-bo.example/a.png', ['10.0.0.5']],
    ['host phân giải ra một địa chỉ công khai và một nội bộ', 'https://tron.example/a.png', ['93.184.216.34', '127.0.0.1']],
    ['host phân giải ra NAT64 trỏ vào mạng riêng', 'https://nat64.example/a.png', ['64:ff9b::a00:5']],
    ['host phân giải ra 6to4 nhúng loopback', 'https://6to4.example/a.png', ['2002:7f00:1::1']],
    ['host phân giải ra Teredo', 'https://teredo.example/a.png', ['2001:0:4136:e378:8000:63bf:3fff:fdd2']],
    ['6to4 trên URL', 'http://[2002:a00:1::1]/a.png', []],
    ['IP loopback trên URL', 'http://127.0.0.1:3000/a.png', []],
    ['IPv4-mapped IPv6 trên URL (Node chuẩn hoá về hex)', 'http://[::ffff:127.0.0.1]/a.png', []],
    ['IPv6 link-local', 'http://[fe80::1]/a.png', []],
    ['198.18/15 trên URL', 'http://198.18.0.1/a.png', []],
    ['không phân giải được', 'https://khong-co.example/a.png', []],
    ['URL có tài khoản', 'https://u:p@cdn.example.vn/a.png', ['93.184.216.34']],
  ])('%s → rejected image_source_invalid, không tải', async (_name, url, addrs) => {
    const san = fakeSan({});
    const err = await san
      .methods({ image: { resolveHost: async () => addrs } })
      .uploadImage(TOKEN, url)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'rejected', platformCode: 'image_source_invalid' });
    expect(san.fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    ['IPv4 loopback', '127.0.0.1'],
    ['IPv4 10/8', '10.1.2.3'],
    ['IPv4 172.16/12', '172.16.0.1'],
    ['IPv4 192.168/16', '192.168.0.1'],
    ['IPv4 link-local, metadata đám mây', '169.254.169.254'],
    ['IPv4 CGNAT', '100.64.0.1'],
    ['IPv4 0/8', '0.0.0.0'],
    ['IPv4 198.18/15 đầu dải', '198.18.0.1'],
    ['IPv4 198.18/15 cuối dải', '198.19.255.255'],
    ['IPv4 multicast', '224.0.0.1'],
    ['IPv6 không xác định ::', '::'],
    ['IPv6 loopback ::1', '::1'],
    ['IPv4-compatible trỏ loopback', '::127.0.0.1'],
    ['IPv4-compatible trỏ mạng riêng (hex)', '::a00:1'],
    ['IPv4-mapped mạng riêng', '::ffff:10.0.0.1'],
    ['IPv4-mapped mạng riêng dạng hex', '::ffff:a00:1'],
    ['IPv4-mapped loopback dạng hex', '::ffff:7f00:1'],
    ['IPv4-mapped metadata', '::ffff:169.254.169.254'],
    ['NAT64 64:ff9b::/96 trỏ mạng riêng', '64:ff9b::a00:1'],
    ['NAT64 64:ff9b::/96 trỏ địa chỉ công khai', '64:ff9b::808:808'],
    ['NAT64 cục bộ 64:ff9b:1::/48', '64:ff9b:1::1'],
    ['discard 100::/64', '100::1'],
    ['ULA fc00::/7', 'fd00::1'],
    ['link-local fe80::/10', 'fe80::1'],
    ['site-local fec0::/10', 'fec0::1'],
    ['multicast ff00::/8', 'ff02::1'],
    ['6to4 2002::/16 nhúng 127.0.0.1', '2002:7f00:1::1'],
    ['6to4 2002::/16 nhúng địa chỉ công khai', '2002:808:808::1'],
    ['Teredo 2001::/32', '2001:0:4136:e378:8000:63bf:3fff:fdd2'],
    ['khối IETF 2001::/23 (benchmark 2001:2::/48)', '2001:2::1'],
    ['khối IETF 2001::/23 (ORCHIDv2 2001:20::/28)', '2001:20::1'],
    ['tài liệu 2001:db8::/32', '2001:db8::1'],
    ['tài liệu 3fff::/20', '3fff::1'],
    ['ngoài 2000::/3 (4000::/3)', '4000::1'],
    ['không phải IP', 'khong-phai-ip'],
  ])('isPrivateAddress chặn %s (%s)', (_name, ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each([
    ['IPv4 công khai', '93.184.216.34'],
    ['IPv4 sát dải 172.16/12', '172.32.0.1'],
    ['IPv4 sát dải 198.18/15', '198.20.0.1'],
    ['IPv6 unicast toàn cầu', '2001:4860::8888'],
    ['IPv6 unicast toàn cầu 2400::/12', '2404:6800:4003::200e'],
    ['IPv6 sát khối IETF 2001::/23', '2001:200::1'],
    ['IPv6 sát tài liệu 3fff::/20', '3fff:1000::1'],
    ['IPv4-mapped địa chỉ công khai', '::ffff:93.184.216.34'],
    ['IPv4-mapped công khai dạng hex', '::ffff:5db8:d822'],
  ])('isPrivateAddress cho phép %s (%s)', (_name, ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
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

  it('đã tạo xong mà bước đọc lại gặp unauthorized: vẫn trả sản phẩm (live false), không ném để bên gọi không tạo lại', async () => {
    const san = fakeSan(routes(fail(105002, 'Expired credentials. The `x-tts-access-token` header has expired.')));
    expect(await san.methods().createProduct(TOKEN, product)).toEqual({ externalProductId: 'P9', externalSkuId: 'S9', live: false });
    expect(san.calls.filter((c) => c.method === 'POST' && c.path === '/product/202309/products')).toHaveLength(1);
  });

  it('idempotent theo seller_sku: findSku thấy SKU còn trên sàn thì trả sản phẩm đó, không gọi tạo', async () => {
    const san = fakeSan(routes(ok({ status: 'ACTIVATE' })));
    const findSku = vi.fn(async () => ({
      externalProductId: 'P1',
      externalSkuId: 'S1',
      sellerSku: product.sellerSku,
      title: 't',
      state: 'review' as const,
      rejectReason: null,
      quantity: 5,
    }));
    expect(await san.methods({ findSku }).createProduct(TOKEN, product)).toEqual({ externalProductId: 'P1', externalSkuId: 'S1', live: false });
    expect(findSku).toHaveBeenCalledWith(TOKEN, 'CM-TEST-COC');
    expect(san.calls).toHaveLength(0);
  });

  it('adapter TikTok tra Search Products theo seller_sku trước khi tạo: đã có thì không tạo, chỉ có bản đã xoá thì tạo', async () => {
    const search = (status: string) =>
      ok({ total_count: 1, products: [{ id: 'P1', title: 't', status, skus: [{ id: 'S1', seller_sku: 'CM-TEST-COC', inventory: [] }] }] });
    const make = (status: string) => {
      const san = fakeSan({ ...routes(ok({ status: 'ACTIVATE' })), 'POST /product/202502/products/search': search(status) });
      return { san, adapter: createTiktokAdapter(config, san.fetchFn) };
    };
    const live = make('ACTIVATE');
    expect(await live.adapter.createProduct(TOKEN, product)).toEqual({ externalProductId: 'P1', externalSkuId: 'S1', live: true });
    expect(live.san.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /product/202502/products/search']);
    expect(live.san.calls[0]!.body).toEqual({ status: 'ALL', seller_skus: ['CM-TEST-COC'] });
    const deleted = make('DELETED');
    expect(await deleted.adapter.createProduct(TOKEN, product)).toMatchObject({ externalProductId: 'P9', externalSkuId: 'S9' });
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

describe('createProduct: khoá của lượt đẩy (#219)', () => {
  const base = {
    externalCategoryId: '600042',
    attributes: {},
    name: 'CM-TEST Cốc sứ có quai 350ml thử API',
    description: 'Cốc thử',
    imageUrls: ['tos-alisg/abc'],
    sellerSku: 'CM-TEST-COC',
    price: '99000',
    quantity: 5,
    weightG: 300,
    lengthMm: 95,
    widthMm: 100,
    heightMm: 120,
    idempotencyKey: 'cm-l1-1794394649000',
  };
  const routes = (create: Response) => ({
    'GET /logistics/202309/warehouses': ok(WAREHOUSES),
    'GET /product/202309/categories/600042/attributes': ok({ attributes: [] }),
    'POST /product/202309/products': create,
    'GET /product/202309/products/P9': ok({ status: 'ACTIVATE' }),
  });
  const remote = { externalProductId: 'P1', externalSkuId: 'S1', sellerSku: 'CM-TEST-COC', title: 't', state: 'live' as const, rejectReason: null, quantity: 5 };

  it('AC-18: gửi idempotency_key của lượt; không có khoá thì không gửi trường', async () => {
    const san = fakeSan(routes(ok({ product_id: 'P9', skus: [{ id: 'S9' }] })));
    await san.methods().createProduct(TOKEN, base);
    await san.methods().createProduct(TOKEN, { ...base, idempotencyKey: undefined });
    const bodies = san.calls.filter((c) => c.method === 'POST' && c.path === '/product/202309/products').map((c) => c.body as Record<string, unknown>);
    expect(bodies[0]!.idempotency_key).toBe('cm-l1-1794394649000');
    expect(bodies[1]).not.toHaveProperty('idempotency_key');
  });

  it('AC-18: sàn trả 12052996 (khoá đã dùng) thì tra seller_sku: thấy thì nhận sản phẩm đó, chưa thấy thì lỗi tạm để thử lại', async () => {
    const dup = () => fail(12052996, 'Precondition Required. This operation requires a unique `external_id`.');
    let seen: typeof remote | null = null;
    const findSku = vi.fn(async () => seen);
    // Lần tra trước khi tạo chưa thấy; lần tra sau 12052996 thấy (Search trễ).
    findSku.mockResolvedValueOnce(null);
    seen = remote;
    expect(await fakeSan(routes(dup())).methods({ findSku }).createProduct(TOKEN, base)).toEqual({ externalProductId: 'P1', externalSkuId: 'S1', live: true });
    const miss = vi.fn(async () => null);
    await expect(fakeSan(routes(dup())).methods({ findSku: miss }).createProduct(TOKEN, base)).rejects.toMatchObject({
      kind: 'unavailable',
      platformCode: '12052996',
    });
    expect(miss).toHaveBeenCalledTimes(2);
  });
});

describe('updateProduct: đẩy lại sản phẩm đã có (#219)', () => {
  const p = {
    externalCategoryId: '600042',
    attributes: { '100149': 'Việt Nam' },
    name: 'CM-TEST Cốc sứ có quai 350ml sửa lại',
    description: 'Cốc thử',
    imageUrls: ['tos-alisg/new'],
    sellerSku: 'CM-TEST-COC',
    price: '120000',
    quantity: 5,
    weightG: 300,
    lengthMm: 95,
    widthMm: 100,
    heightMm: 120,
  };
  const current = {
    id: 'P1',
    status: 'FAILED',
    brand: { id: 'B7', name: 'Hãng' },
    delivery_options: [
      { id: 'D1', name: 'STANDARD', is_available: true },
      { id: 'D2', name: 'EXPRESS', is_available: false },
    ],
    is_cod_allowed: false,
    skus: [
      { id: 'S1', seller_sku: 'CM-TEST-COC', sales_attributes: [] },
      { id: 'S2', seller_sku: 'KHAC', sales_attributes: [{ id: '100000', name: 'Màu', value_id: 'V2', value_name: 'Đen', sku_img: { uri: 'tos/x', urls: ['u'] } }] },
    ],
  };
  const make = (statuses: string[], extra: Record<string, Response> = {}) => {
    const reads = [current, ...statuses.map((status) => ({ ...current, status }))];
    return fakeSan({
      'GET /product/202309/categories/600042/attributes': ok({
        attributes: [{ id: '100149', type: 'PRODUCT_PROPERTY', values: [{ id: '1000854', name: 'Việt Nam' }] }],
      }),
      'GET /product/202309/products/P1': (() => {
        let i = 0;
        return () => ok(reads[Math.min(i++, reads.length - 1)]);
      })(),
      'PUT /product/202509/products/P1': ok({ product_id: 'P1' }),
      'POST /product/202309/products/activate': ok({}),
      ...extra,
    });
  };

  it('C2-03: Edit Product 202509 gửi nội dung mới, giữ thương hiệu, cách giao, COD, mọi SKU; không gửi tồn', async () => {
    const san = make(['PENDING']);
    expect(await san.methods().updateProduct!(TOKEN, 'P1', 'S1', p)).toEqual({ live: false });
    const put = san.calls.find((c) => c.method === 'PUT')!;
    expect(put.path).toBe('/product/202509/products/P1');
    expect(put.body).toEqual({
      save_mode: 'LISTING',
      title: p.name,
      description: '<p>Cốc thử</p>',
      category_id: '600042',
      category_version: 'v2',
      main_images: [{ uri: 'tos-alisg/new' }],
      package_weight: { value: '0.3', unit: 'KILOGRAM' },
      package_dimensions: { length: '10', width: '10', height: '12', unit: 'CENTIMETER' },
      product_attributes: [{ id: '100149', values: [{ id: '1000854' }] }],
      brand_id: 'B7',
      delivery_option_ids: ['D1'],
      is_cod_allowed: false,
      skus: [
        { id: 'S1', seller_sku: 'CM-TEST-COC', price: { amount: '120000', currency: 'VND' } },
        { id: 'S2', seller_sku: 'KHAC', sales_attributes: [{ id: '100000', value_id: 'V2', value_name: 'Đen', sku_img: { uri: 'tos/x' } }] },
      ],
    });
    expect(san.calls.some((c) => c.path.endsWith('/activate'))).toBe(false);
  });

  it('sản phẩm người bán đã tắt (dòng mới sau gỡ) thì bật lại; sàn cho bán ngay thì live', async () => {
    const san = make(['SELLER_DEACTIVATED', 'ACTIVATE']);
    expect(await san.methods().updateProduct!(TOKEN, 'P1', 'S1', p)).toEqual({ live: true });
    expect(san.calls.find((c) => c.path === '/product/202309/products/activate')!.body).toEqual({ product_ids: ['P1'] });
  });

  it('vẫn tắt hay bị khoá sau khi ghi thì rejected still_inactive; SKU không còn trên sản phẩm thì sku_not_found, không gọi Edit', async () => {
    await expect(make(['PLATFORM_DEACTIVATED']).methods().updateProduct!(TOKEN, 'P1', 'S1', p)).rejects.toMatchObject({
      kind: 'rejected',
      platformCode: 'still_inactive',
    });
    const san = make(['PENDING']);
    await expect(san.methods().updateProduct!(TOKEN, 'P1', 'S404', p)).rejects.toMatchObject({ platformCode: 'sku_not_found' });
    expect(san.calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});

describe('getSkus: lý do sàn từ chối (#219 AC-19)', () => {
  it('tiktokAuditReason nối reasons, suggestions từng mục; không có thì null', () => {
    expect(
      tiktokAuditReason({
        audit_failed_reasons: [
          { position: 'product', reasons: ['violate listing rules'], suggestions: ['Sửa ảnh rồi gửi lại.'] },
          { position: 'title', reasons: ['Tiêu đề sai'], suggestions: [] },
        ],
      }),
    ).toBe('violate listing rules: Sửa ảnh rồi gửi lại.; Tiêu đề sai');
    expect(tiktokAuditReason({ audit_failed_reasons: [] })).toBeNull();
    expect(tiktokAuditReason(undefined)).toBeNull();
  });

  it('sản phẩm FAILED: đọc Get Product lấy lý do; sàn từ chối đọc thì để null; sản phẩm khác không đọc', async () => {
    const search = ok({
      total_count: 2,
      products: [
        { id: 'P1', title: 'a', status: 'FAILED', skus: [{ id: 'S1', seller_sku: 'A', inventory: [] }] },
        { id: 'P2', title: 'b', status: 'ACTIVATE', skus: [{ id: 'S2', seller_sku: 'B', inventory: [] }] },
      ],
    });
    const make = (detail: Response) =>
      fakeSan({ 'POST /product/202502/products/search': search, 'GET /product/202309/products/P1': detail });
    const san = make(ok({ audit_failed_reasons: [{ reasons: ['Ảnh mờ'], suggestions: ['Thay ảnh rõ hơn'] }] }));
    const skus = await createTiktokAdapter(config, san.fetchFn).getSkus(TOKEN, ['A', 'B']);
    expect(skus.map((s) => [s.sellerSku, s.state, s.rejectReason])).toEqual([
      ['A', 'rejected', 'Ảnh mờ: Thay ảnh rõ hơn'],
      ['B', 'live', null],
    ]);
    expect(san.calls.filter((c) => c.method === 'GET').map((c) => c.path)).toEqual(['/product/202309/products/P1']);
    const denied = make(fail(12052900, 'product not found'));
    expect((await createTiktokAdapter(config, denied.fetchFn).getSkus(TOKEN, ['A']))[0]!.rejectReason).toBeNull();
  });
});

it('adapter TikTok có đủ năng lực listing (không còn unsupported), kể cả activate', () => {
  const adapter = createTiktokAdapter(config, vi.fn<typeof fetch>());
  for (const k of ['listCategories', 'categoryAttributes', 'uploadImage', 'createProduct', 'updateProduct', 'updatePriceQuantity', 'deactivate', 'activate'] as const) {
    expect(typeof adapter[k]).toBe('function');
  }
  expect(adapter.capabilities.hideBy).toBe('deactivate');
});
