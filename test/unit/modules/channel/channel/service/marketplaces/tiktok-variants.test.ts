// Adapter TikTok: sản phẩm nhiều SKU, addVariants, removeVariants (#295). Dạng body theo lần gọi thật 21/11/2026
// (Documents/tich-hop-san/goi-thu-bien-the-thong-so.md mục 2c.1: Create Product 202309, Partial Edit 202509); sàn giả theo đường dẫn.
import { describe, expect, it, vi } from 'vitest';
import type { NewProduct, NewVariants, RemoteSku, SalesAttribute } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { createTiktokClient, packTiktokToken } from '#src/modules/channel/channel/service/marketplaces/tiktok-client.ts';
import { tiktokListingMethods } from '#src/modules/channel/channel/service/marketplaces/tiktok-listing.ts';

const config = { appKey: 'appk', appSecret: 'apps', serviceId: undefined, apiUrl: 'https://open.test', authUrl: 'https://auth.test' };
const TOKEN = packTiktokToken({ token: 'TTP_at', cipher: 'ROW_c', shopId: '749' });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ok = (data: unknown) => json({ code: 0, message: 'Success', request_id: 'r', data });

const WAREHOUSES = { warehouses: [{ id: 'W1', type: 'SALES_WAREHOUSE', is_default: true, effect_status: 'ENABLED' }] };
const PRECHECK_OK = {
  'GET /product/202312/prerequisites': ok({ check_results: [{ check_item: 'SHOP_STATUS', is_failed: false, fail_reasons: [] }] }),
  'POST /product/202309/products/listing_check': ok({ check_result: 'PASS' }),
};

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function fakeSan(routes: Record<string, Response | ((body: unknown) => Response)>) {
  const calls: Call[] = [];
  const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
    const u = new URL(String(input));
    const raw = init?.body;
    const body = typeof raw === 'string' ? JSON.parse(raw) : raw;
    calls.push({ method: init?.method ?? 'GET', path: u.pathname, body });
    const r = routes[`${init?.method ?? 'GET'} ${u.pathname}`];
    if (!r) return json({ code: 36009009, message: 'Invalid path' });
    return typeof r === 'function' ? r(body) : r.clone();
  });
  return { calls, methods: (deps = {}) => tiktokListingMethods(createTiktokClient(config, fetchFn), deps) };
}

const salesAttributes: SalesAttribute[] = [
  {
    code: '100000',
    name: 'Màu',
    values: [
      { optionId: null, label: 'Đen', imageUri: 'tos/den' },
      { optionId: '7707619539866011413', label: 'Trắng', imageUri: 'tos/trang' },
    ],
  },
  { code: '100007', name: 'Cỡ', values: [{ optionId: null, label: 'S' }] },
];
const dims = { weightG: 300, lengthMm: 200, widthMm: 150, heightMm: 30 };
const product: NewProduct = {
  externalCategoryId: '600042',
  attributes: {},
  name: 'CM-T295 áo thun thử thêm biến thể không bán',
  description: 'Áo',
  imageUrls: ['tos/main'],
  sellerSku: 'CM-DEN-S',
  price: '99000',
  ...dims,
  salesAttributes,
  skus: [
    { sellerSku: 'CM-DEN-S', price: '99000', quantity: 5, values: ['Đen', 'S'], ...dims },
    { sellerSku: 'CM-TRANG-S', price: '99000', quantity: 0, values: ['Trắng', 'S'], ...dims },
  ],
};
const createRoutes = (created: unknown) => ({
  'GET /logistics/202309/warehouses': ok(WAREHOUSES),
  'GET /product/202309/categories/600042/attributes': ok({ attributes: [] }),
  ...PRECHECK_OK,
  'POST /product/202309/products': ok(created),
  'GET /product/202309/products/P1': ok({ status: 'PENDING' }),
});
const remote = (productId: string, skuId: string, sellerSku: string): RemoteSku => ({
  externalProductId: productId,
  externalSkuId: skuId,
  sellerSku,
  title: 't',
  state: 'review',
  rejectReason: null,
  quantity: 5,
});

describe('TikTok createProduct nhiều SKU', () => {
  it('mỗi SKU có sales_attributes theo thứ tự trục (id, value_name, value_id, sku_img); ghép kết quả theo seller_sku khi sàn trả ngược', async () => {
    const san = fakeSan(
      createRoutes({
        product_id: 'P1',
        skus: [
          { id: 'S2', seller_sku: 'CM-TRANG-S' },
          { id: 'S1', seller_sku: 'CM-DEN-S' },
        ],
      }),
    );
    const created = await san.methods().createProduct(TOKEN, product);
    expect(created).toEqual({
      externalProductId: 'P1',
      externalSkuId: 'S1',
      live: false,
      skus: [
        { sellerSku: 'CM-DEN-S', externalSkuId: 'S1' },
        { sellerSku: 'CM-TRANG-S', externalSkuId: 'S2' },
      ],
    });
    const body = san.calls.find((c) => c.method === 'POST' && c.path === '/product/202309/products')!.body as { skus: unknown[] };
    expect(body.skus).toEqual([
      {
        seller_sku: 'CM-DEN-S',
        price: { amount: '99000', currency: 'VND' },
        inventory: [{ warehouse_id: 'W1', quantity: 5 }],
        sales_attributes: [
          { id: '100000', value_name: 'Đen', sku_img: { uri: 'tos/den' } },
          { id: '100007', value_name: 'S' },
        ],
      },
      {
        seller_sku: 'CM-TRANG-S',
        price: { amount: '99000', currency: 'VND' },
        inventory: [{ warehouse_id: 'W1' }],
        sales_attributes: [
          { id: '100000', value_name: 'Trắng', value_id: '7707619539866011413', sku_img: { uri: 'tos/trang' } },
          { id: '100007', value_name: 'S' },
        ],
      },
    ]);
  });

  it('trục tự đặt tên (code null) gửi name thay cho id', async () => {
    const san = fakeSan(createRoutes({ product_id: 'P1', skus: [{ id: 'S1', seller_sku: 'A' }, { id: 'S2', seller_sku: 'B' }] }));
    await san.methods().createProduct(TOKEN, {
      ...product,
      salesAttributes: [{ code: null, name: 'Mùi', values: [{ optionId: null, label: 'Hồng' }, { optionId: null, label: 'Cam' }] }],
      skus: [
        { sellerSku: 'A', price: '1', values: ['Hồng'], ...dims },
        { sellerSku: 'B', price: '1', values: ['Cam'], ...dims },
      ],
    });
    const body = san.calls.find((c) => c.method === 'POST' && c.path === '/product/202309/products')!.body as { skus: { sales_attributes: unknown[] }[] };
    expect(body.skus[0]!.sales_attributes).toEqual([{ name: 'Mùi', value_name: 'Hồng' }]);
  });

  it('một SKU: không có sales_attributes, không trả skus', async () => {
    const san = fakeSan(createRoutes({ product_id: 'P1', skus: [{ id: 'S1', seller_sku: 'CM-DEN-S' }] }));
    const single: NewProduct = { ...product, salesAttributes: undefined, skus: undefined };
    expect(await san.methods().createProduct(TOKEN, { ...single, quantity: 5 })).toEqual({ externalProductId: 'P1', externalSkuId: 'S1', live: false });
    const body = san.calls.find((c) => c.method === 'POST' && c.path === '/product/202309/products')!.body as { skus: object[] };
    expect(body.skus).toEqual([{ seller_sku: 'CM-DEN-S', price: { amount: '99000', currency: 'VND' }, inventory: [{ warehouse_id: 'W1', quantity: 5 }] }]);
  });

  it('chống trùng: đủ SKU cùng sản phẩm thì existing: true kèm skus, không gọi tạo', async () => {
    const san = fakeSan(createRoutes({}));
    const hits: Record<string, RemoteSku> = { 'CM-DEN-S': remote('P7', 'S1', 'CM-DEN-S'), 'CM-TRANG-S': remote('P7', 'S2', 'CM-TRANG-S') };
    const findSku = vi.fn(async (_t: string, sku: string) => hits[sku] ?? null);
    const created = await san.methods({ findSku }).createProduct(TOKEN, product);
    expect(created).toMatchObject({
      externalProductId: 'P7',
      externalSkuId: 'S1',
      existing: true,
      skus: [
        { sellerSku: 'CM-DEN-S', externalSkuId: 'S1' },
        { sellerSku: 'CM-TRANG-S', externalSkuId: 'S2' },
      ],
    });
    expect(san.calls).toHaveLength(0);
  });

  it('chống trùng: chỉ một phần SKU hoặc khác sản phẩm thì sku_exists_on_platform', async () => {
    const san = fakeSan(createRoutes({}));
    const partial = vi.fn(async (_t: string, sku: string) => (sku === 'CM-DEN-S' ? remote('P7', 'S1', sku) : null));
    await expect(san.methods({ findSku: partial }).createProduct(TOKEN, product)).rejects.toMatchObject({ kind: 'rejected', platformCode: 'sku_exists_on_platform' });
    const split = vi.fn(async (_t: string, sku: string) => remote(sku === 'CM-DEN-S' ? 'P7' : 'P8', 'S', sku));
    await expect(san.methods({ findSku: split }).createProduct(TOKEN, product)).rejects.toMatchObject({ platformCode: 'sku_exists_on_platform' });
    expect(san.calls).toHaveLength(0);
  });
});

describe('TikTok addVariants, removeVariants', () => {
  const current = {
    skus: [
      {
        id: 'S1',
        seller_sku: 'CM-DEN-S',
        price: { sale_price: '99000', tax_exclusive_price: '99000', currency: 'VND' },
        inventory: [{ warehouse_id: 'W1', quantity: 5 }],
        sales_attributes: [{ id: '100000', name: 'Màu', value_id: 'V-DEN', value_name: 'Đen', sku_img: { uri: 'tos/den' } }, { id: '100007', value_id: 'V-S', value_name: 'S' }],
      },
      {
        id: 'S2',
        seller_sku: 'CM-TRANG-S',
        price: { sale_price: '99000', currency: 'VND' },
        inventory: [{ warehouse_id: 'W1', quantity: 5 }],
        sales_attributes: [{ id: '100000', value_id: 'V-TRANG', sku_img: { uri: 'tos/trang' } }, { id: '100007', value_id: 'V-S' }],
      },
    ],
  };
  const oldSkus = [
    {
      id: 'S1',
      seller_sku: 'CM-DEN-S',
      price: { amount: '99000', currency: 'VND' },
      inventory: [{ warehouse_id: 'W1', quantity: 5 }],
      sales_attributes: [{ id: '100000', value_id: 'V-DEN', sku_img: { uri: 'tos/den' } }, { id: '100007', value_id: 'V-S' }],
    },
    {
      id: 'S2',
      seller_sku: 'CM-TRANG-S',
      price: { amount: '99000', currency: 'VND' },
      inventory: [{ warehouse_id: 'W1', quantity: 5 }],
      sales_attributes: [{ id: '100000', value_id: 'V-TRANG', sku_img: { uri: 'tos/trang' } }, { id: '100007', value_id: 'V-S' }],
    },
  ];
  const input: NewVariants = {
    ...product,
    salesAttributes: [
      { code: '100000', name: 'Màu', values: [{ optionId: null, label: 'Đỏ', imageUri: 'tos/do' }] },
      { code: '100007', name: 'Cỡ', values: [{ optionId: null, label: 'S' }] },
    ],
    skus: [{ sellerSku: 'CM-DO-S', price: '99000', quantity: 5, values: ['Đỏ', 'S'], ...dims }],
  };
  const edit = 'POST /product/202509/products/P1/partial_edit';

  it('addVariants gửi lại mọi SKU cũ có id (giá, tồn, trục lấy từ sàn) cộng SKU mới không id; ghép theo seller_sku; live false', async () => {
    const san = fakeSan({
      'GET /logistics/202309/warehouses': ok(WAREHOUSES),
      'GET /product/202309/products/P1': ok(current),
      [edit]: ok({ skus: [{ id: 'S1', seller_sku: 'CM-DEN-S' }, { id: 'S9', seller_sku: 'CM-DO-S' }, { id: 'S2', seller_sku: 'CM-TRANG-S' }] }),
    });
    const result = await san.methods().addVariants!(TOKEN, 'P1', input);
    expect(result).toEqual({ skus: [{ sellerSku: 'CM-DO-S', externalSkuId: 'S9' }], live: false });
    expect(san.calls.find((c) => c.path.endsWith('partial_edit'))!.body).toEqual({
      skus: [
        ...oldSkus,
        {
          seller_sku: 'CM-DO-S',
          price: { amount: '99000', currency: 'VND' },
          inventory: [{ warehouse_id: 'W1', quantity: 5 }],
          sales_attributes: [{ id: '100000', value_name: 'Đỏ', sku_img: { uri: 'tos/do' } }, { id: '100007', value_name: 'S' }],
        },
      ],
    });
  });

  it('addVariants: SKU mới tồn 0 hoặc chưa có số vẫn gửi quantity 0 (Partial Edit bắt buộc, 36009004)', async () => {
    const san = fakeSan({
      'GET /logistics/202309/warehouses': ok(WAREHOUSES),
      'GET /product/202309/products/P1': ok(current),
      [edit]: ok({ skus: [{ id: 'S9', seller_sku: 'CM-DO-S' }, { id: 'S10', seller_sku: 'CM-DO-M' }] }),
    });
    const zero: NewVariants = {
      ...input,
      salesAttributes: [input.salesAttributes![0]!, { code: '100007', name: 'Cỡ', values: [{ optionId: null, label: 'S' }, { optionId: null, label: 'M' }] }],
      skus: [
        { ...input.skus[0]!, quantity: 0 },
        { ...input.skus[0]!, sellerSku: 'CM-DO-M', quantity: undefined, values: ['Đỏ', 'M'] },
      ],
    };
    await san.methods().addVariants!(TOKEN, 'P1', zero);
    const sent = (san.calls.find((c) => c.path.endsWith('partial_edit'))!.body as { skus: { seller_sku: string; inventory: unknown }[] }).skus;
    expect(sent.filter((x) => x.seller_sku.startsWith('CM-DO')).map((x) => x.inventory)).toEqual([
      [{ warehouse_id: 'W1', quantity: 0 }],
      [{ warehouse_id: 'W1', quantity: 0 }],
    ]);
  });

  it('addVariants: phản hồi thiếu SKU mới thì đọc lại Get Product; vẫn thiếu thì unexpected_response', async () => {
    const reread = fakeSan({
      'GET /logistics/202309/warehouses': ok(WAREHOUSES),
      'GET /product/202309/products/P1': () => ok(current),
      [edit]: ok({}),
    });
    await expect(reread.methods().addVariants!(TOKEN, 'P1', input)).rejects.toMatchObject({ platformCode: 'unexpected_response' });
    expect(reread.calls.filter((c) => c.path === '/product/202309/products/P1')).toHaveLength(2);
  });

  it('addVariants: seller sku đã có trên sản phẩm sàn thì sku_exists_on_platform, không sửa', async () => {
    const san = fakeSan({ 'GET /logistics/202309/warehouses': ok(WAREHOUSES), 'GET /product/202309/products/P1': ok(current), [edit]: ok({}) });
    const dup: NewVariants = { ...input, skus: [{ ...input.skus[0]!, sellerSku: 'CM-DEN-S' }] };
    await expect(san.methods().addVariants!(TOKEN, 'P1', dup)).rejects.toMatchObject({ platformCode: 'sku_exists_on_platform' });
    expect(san.calls.some((c) => c.path.endsWith('partial_edit'))).toBe(false);
  });

  it('removeVariants bỏ đúng SKU, gửi lại các SKU còn lại có id', async () => {
    const san = fakeSan({ 'GET /product/202309/products/P1': ok(current), [edit]: ok({}) });
    await san.methods().removeVariants!(TOKEN, 'P1', ['S2']);
    expect(san.calls.find((c) => c.path.endsWith('partial_edit'))!.body).toEqual({ skus: [oldSkus[0]] });
  });

  it('removeVariants bỏ hết SKU thì last_variant, không gọi sửa', async () => {
    const san = fakeSan({ 'GET /product/202309/products/P1': ok(current), [edit]: ok({}) });
    await expect(san.methods().removeVariants!(TOKEN, 'P1', ['S1', 'S2'])).rejects.toMatchObject({ kind: 'rejected', platformCode: 'last_variant' });
    expect(san.calls.some((c) => c.path.endsWith('partial_edit'))).toBe(false);
  });
});
