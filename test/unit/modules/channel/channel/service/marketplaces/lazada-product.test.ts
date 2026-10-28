import { describe, expect, it, vi } from 'vitest';
import { createLazadaAdapter, lazadaError } from '#src/modules/channel/channel/service/marketplaces/lazada.ts';

const config = {
  appKey: '143465',
  appSecret: 'secret',
  redirectUrl: undefined,
  apiUrl: 'https://api.test/rest',
  authUrl: 'https://auth.test',
};

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function fakeFetch(...bodies: unknown[]) {
  const fn = vi.fn<typeof fetch>();
  for (const b of bodies) fn.mockResolvedValueOnce(json(b));
  return fn;
}

/** Tham số của lần gọi thứ `i`: POST đọc form body, GET đọc query. */
function sent(fn: ReturnType<typeof fakeFetch>, i = 0) {
  const [url, init] = fn.mock.calls[i] ?? [];
  const u = new URL(String(url));
  const body = init?.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
  return { path: u.pathname, method: init?.method, query: Object.fromEntries(u.searchParams), body };
}

describe('lazadaError với API sản phẩm', () => {
  it('mã số mang type ISP là sàn từ chối, trừ mã lỗi tạm', () => {
    // Payload thật 28/10/2026 (probe-104b): lỗi nghiệp vụ sản phẩm cũng mang type ISP.
    expect(lazadaError({ code: '501', type: 'ISP', message: 'E501: Update product failed' }).kind).toBe('rejected');
    expect(lazadaError({ code: '302', type: 'ISP', message: 'E302: Not supported URL' }).kind).toBe('rejected');
    expect(lazadaError({ code: '901', type: 'ISP', message: 'E901' }).kind).toBe('unavailable');
    expect(lazadaError({ code: 'ServiceTimeout', type: 'ISP' }).kind).toBe('unavailable');
  });
});

describe('adapter Lazada: sản phẩm', () => {
  it('danh mục: chỉ lấy danh mục lá, tên là cả đường dẫn', async () => {
    const fn = fakeFetch({
      code: '0',
      data: [
        {
          category_id: 1,
          name: 'Quần áo nam',
          leaf: false,
          children: [{ category_id: 14275, name: 'Áo thun có cổ nam', leaf: true }],
        },
      ],
    });
    expect(await createLazadaAdapter(config, fn).listCategories('t')).toEqual([
      { externalId: '14275', name: 'Quần áo nam > Áo thun có cổ nam' },
    ]);
    expect(sent(fn).query).toMatchObject({ language_code: 'vi_VN', access_token: 't' });
  });

  it('thuộc tính: chỉ thuộc tính bắt buộc cấp sản phẩm', async () => {
    const fn = fakeFetch({
      code: '0',
      data: [
        { name: 'brand', label: 'Thương hiệu', is_mandatory: 1, attribute_type: 'normal', options: [{ name: 'No Brand' }] },
        { name: 'name', label: 'Tên', is_mandatory: 1, attribute_type: 'normal', options: [] },
        { name: 'price', label: 'Giá', is_mandatory: 1, attribute_type: 'sku' },
        { name: 'color', label: 'Màu', is_mandatory: 0, attribute_type: 'normal' },
      ],
    });
    expect(await createLazadaAdapter(config, fn).categoryAttributes('t', '14275')).toEqual([
      { name: 'brand', label: 'Thương hiệu', options: ['No Brand'] },
    ]);
    expect(sent(fn).query.primary_category_id).toBe('14275');
  });

  it('đưa ảnh lên sàn: POST form body, URL thoát ký tự XML', async () => {
    const fn = fakeFetch({ code: '0', data: { image: { url: 'https://sg-test-11.slatic.net/p/a.png' } } });
    expect(await createLazadaAdapter(config, fn).uploadImage('t', 'https://img.test/a.png?s=460&v=4')).toBe(
      'https://sg-test-11.slatic.net/p/a.png',
    );
    const call = sent(fn);
    expect(call).toMatchObject({ path: '/rest/image/migrate', method: 'POST' });
    expect(call.query).toEqual({});
    expect(call.body.payload).toContain('<Url>https://img.test/a.png?s=460&amp;v=4</Url>');
    expect(call.body.sign).toMatch(/^[0-9A-F]{64}$/);
  });

  it('tạo sản phẩm: payload theo tài liệu, đổi gam → kg, mm → cm', async () => {
    const fn = fakeFetch({
      code: '0',
      data: { item_id: '2374791958', sku_list: [{ seller_sku: 'CMR-1', sku_id: '13896560193' }], item_status: 'Active' },
    });
    const created = await createLazadaAdapter(config, fn).createProduct('t', {
      externalCategoryId: '14275',
      attributes: { brand: 'No Brand', clothing_material: 'Cotton' },
      name: 'Áo thun - Đen / M',
      description: 'Áo cotton',
      imageUrls: ['https://sg-test-11.slatic.net/p/a.png'],
      sellerSku: 'CMR-1',
      price: '150000',
      quantity: 7,
      weightG: 250,
      lengthMm: 300,
      widthMm: 200,
      heightMm: 15,
    });
    expect(created).toEqual({ externalProductId: '2374791958', externalSkuId: '13896560193' });
    expect(JSON.parse(sent(fn).body.payload ?? '')).toEqual({
      Request: {
        Product: {
          PrimaryCategory: '14275',
          Images: { Image: ['https://sg-test-11.slatic.net/p/a.png'] },
          Attributes: { brand: 'No Brand', clothing_material: 'Cotton', name: 'Áo thun - Đen / M', description: 'Áo cotton' },
          Skus: {
            Sku: [
              {
                SellerSku: 'CMR-1',
                quantity: '7',
                price: '150000',
                package_weight: '0.25',
                package_length: '30',
                package_width: '20',
                package_height: '1.5',
              },
            ],
          },
        },
      },
    });
  });

  it('đọc SKU theo SellerSku: chuẩn hoá trạng thái, bỏ SKU không trong danh sách', async () => {
    const product = (item_id: string, status: string, sku: string, extra: Record<string, unknown> = {}) => ({
      item_id,
      status,
      attributes: { name: `SP ${sku}` },
      skus: [{ SkuId: Number(item_id) * 10, SellerSku: sku, quantity: 3 }],
      ...extra,
    });
    const fn = fakeFetch({
      code: '0',
      data: {
        products: [
          product('1', 'Active', 'A'),
          product('2', 'Pending QC', 'B'),
          product('3', 'InActive', 'C', { rejectReason: [{ violationDetail: 'Wrong Image' }] }),
          product('4', 'Suspended', 'D'),
          product('5', 'Active', 'NGUOI-KHAC'),
        ],
      },
    });
    const skus = await createLazadaAdapter(config, fn).getSkus('t', ['A', 'B', 'C', 'D']);
    expect(skus.map((s) => [s.sellerSku, s.state, s.rejectReason])).toEqual([
      ['A', 'live', null],
      ['B', 'review', null],
      ['C', 'rejected', 'Wrong Image'],
      ['D', 'hold', null],
    ]);
    expect(skus[0]).toMatchObject({ externalProductId: '1', externalSkuId: '10', quantity: 3, title: 'SP A' });
    expect(JSON.parse(sent(fn).query.sku_seller_list ?? '')).toEqual(['A', 'B', 'C', 'D']);
  });

  it('đổi giá và tồn: chia lô 20, gửi ItemId và SkuId', async () => {
    const items = Array.from({ length: 21 }, (_, i) => ({
      externalProductId: `I${i}`,
      externalSkuId: `S${i}`,
      price: '1000',
      quantity: i,
    }));
    const fn = fakeFetch({ code: '0', data: {} }, { code: '0', data: {} });
    const results = await createLazadaAdapter(config, fn).updatePriceQuantity('t', items);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(21);
    expect(results.every((r) => r.ok)).toBe(true);
    const xml = sent(fn, 1).body.payload;
    expect(xml).toBe(
      '<Request><Product><Skus><Sku><ItemId>I20</ItemId><SkuId>S20</SkuId><Price>1000</Price><Quantity>20</Quantity></Sku></Skus></Product></Request>',
    );
  });

  it('lỗi theo SKU: detail khớp số SKU thì gán theo vị trí, không khớp thì cả lô cùng lỗi', async () => {
    const items = [
      { externalProductId: 'I1', externalSkuId: 'S1', quantity: 1 },
      { externalProductId: 'I2', externalSkuId: 'S2', quantity: 2 },
    ];
    const fn = fakeFetch(
      {
        code: '501',
        type: 'ISP',
        message: 'E501: Update product failed',
        detail: [{ code: 'E0501', message: 'lỗi S1' }, {}],
      },
      { code: '501', type: 'ISP', message: 'E501: Update product failed', detail: [{ code: 'E0501', message: 'x' }] },
    );
    const adapter = createLazadaAdapter(config, fn);
    expect(await adapter.updatePriceQuantity('t', items)).toEqual([
      { externalSkuId: 'S1', ok: false, code: 'E0501', message: 'lỗi S1' },
      { externalSkuId: 'S2', ok: true },
    ]);
    expect(await adapter.updatePriceQuantity('t', items)).toEqual([
      { externalSkuId: 'S1', ok: false, code: '501', message: 'E501: Update product failed' },
      { externalSkuId: 'S2', ok: false, code: '501', message: 'E501: Update product failed' },
    ]);
  });

  it('đổi giá và tồn: token sai thì ném unauthorized', async () => {
    const fn = fakeFetch({ code: 'IllegalAccessToken', type: 'ISV', message: 'x' });
    await expect(
      createLazadaAdapter(config, fn).updatePriceQuantity('t', [{ externalProductId: 'I', externalSkuId: 'S', quantity: 0 }]),
    ).rejects.toMatchObject({ kind: 'unauthorized' });
  });

  it('tắt sản phẩm: tham số apiRequestBody', async () => {
    const fn = fakeFetch({ code: '0', data: {} });
    await createLazadaAdapter(config, fn).deactivate('t', '234', '2069');
    expect(sent(fn)).toMatchObject({ path: '/rest/product/deactivate', method: 'POST' });
    expect(sent(fn).body.apiRequestBody).toBe(
      '<Request><Product><ItemId>234</ItemId><Skus><SkuId>2069</SkuId></Skus></Product></Request>',
    );
  });
});
