// Adapter Lazada: sản phẩm nhiều SKU, addVariants, removeVariants (#295). Dạng body theo lần gọi thật 21/11/2026
// (Documents/tich-hop-san/goi-thu-bien-the-thong-so.md mục 2c.2); sàn giả bằng fetch giả.
// BẪY (#572): khoá khai báo phải viết thường `variation`/`variationN`. Viết hoa thì sàn bỏ qua khai báo, tên tự đặt bị từ chối
// `BIZ_CHECK_SALEPROP_ATTRIBUTE_INVALID` (request_id 0bb4a6bf17955171474545020); viết thường thì nhận (21412a8b17955171484212824).
import { describe, expect, it, vi } from 'vitest';
import type { NewProduct, NewVariants, SalesAttribute } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { createLazadaAdapter } from '#src/modules/channel/channel/service/marketplaces/lazada.ts';
import { lazadaAddVariation, lazadaSkuIdentity, lazadaVariation } from '#src/modules/channel/channel/service/marketplaces/lazada-variants.ts';

const config = { appKey: '143465', appSecret: 'secret', redirectUrl: undefined, apiUrl: 'https://api.test/rest', authUrl: 'https://auth.test' };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function fakeFetch(...bodies: unknown[]) {
  const fn = vi.fn<typeof fetch>();
  for (const b of bodies) fn.mockResolvedValueOnce(json(b));
  return fn;
}

function sent(fn: ReturnType<typeof fakeFetch>, i: number) {
  const [url, init] = fn.mock.calls[i] ?? [];
  const u = new URL(String(url));
  const body = init?.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
  return { path: u.pathname, method: init?.method, query: Object.fromEntries(u.searchParams), body };
}

const payloadOf = (fn: ReturnType<typeof fakeFetch>, i: number) => JSON.parse(sent(fn, i).body.payload ?? '') as { Request: { Product: Record<string, unknown> } };

const salesAttributes: SalesAttribute[] = [
  {
    code: 'color_family',
    name: 'Màu',
    values: [
      { optionId: null, label: 'Đen', imageUri: 'https://img.test/den.jpg' },
      { optionId: null, label: 'Trắng', imageUri: 'https://img.test/trang.jpg' },
    ],
  },
  { code: 'size', name: 'Cỡ', values: [{ optionId: null, label: 'Int:S' }] },
];
const dims = { weightG: 200, lengthMm: 200, widthMm: 150, heightMm: 30 };
const base = {
  externalCategoryId: '7930',
  attributes: { brand: 'No Brand' },
  name: 'Áo thun',
  description: 'Áo',
  imageUrls: ['https://img.test/main.jpg'],
  sellerSku: 'CM-DEN-S',
  price: '199000',
  ...dims,
};
const multi: NewProduct = {
  ...base,
  salesAttributes,
  skus: [
    { sellerSku: 'CM-DEN-S', price: '199000', quantity: 5, values: ['Đen', 'Int:S'], ...dims },
    { sellerSku: 'CM-TRANG-S', price: '199000', quantity: 5, values: ['Trắng', 'Int:S'], ...dims },
  ],
};
const none = { code: '0', data: { products: [] } };
const row = (item: string, status: string, skus: { id: number; sku: string }[]) => ({
  item_id: item,
  status,
  attributes: { name: 'SP' },
  skus: skus.map((s) => ({ SkuId: s.id, SellerSku: s.sku, quantity: 1 })),
});

describe('Lazada createProduct nhiều SKU', () => {
  it('gửi variation (khoá chữ thường), saleProp, Images theo trục; ghép kết quả theo seller_sku dù sàn trả ngược thứ tự', async () => {
    const fn = fakeFetch(none, {
      code: '0',
      data: {
        item_id: '13517941999',
        item_status: 'Active',
        sku_list: [
          { seller_sku: 'CM-TRANG-S', sku_id: '117597811499' },
          { seller_sku: 'CM-DEN-S', sku_id: '117597811498' },
        ],
      },
    });
    const created = await createLazadaAdapter(config, fn).createProduct('t', multi);
    expect(created).toEqual({
      externalProductId: '13517941999',
      externalSkuId: '117597811498',
      live: true,
      skus: [
        { sellerSku: 'CM-DEN-S', externalSkuId: '117597811498' },
        { sellerSku: 'CM-TRANG-S', externalSkuId: '117597811499' },
      ],
    });
    // Tra cả hai seller sku trước khi tạo.
    expect(sent(fn, 0).query.sku_seller_list).toBe('["CM-DEN-S","CM-TRANG-S"]');
    const product = payloadOf(fn, 1).Request.Product;
    expect(product).not.toHaveProperty('Variation');
    expect(product.variation).toEqual({
      variation1: { name: 'color_family', hasImage: true, customize: false, options: { option: ['Đen', 'Trắng'] } },
      variation2: { name: 'size', hasImage: false, customize: false, options: { option: ['Int:S'] } },
    });
    expect(product.Skus).toEqual({
      Sku: [
        {
          SellerSku: 'CM-DEN-S',
          saleProp: { color_family: 'Đen', size: 'Int:S' },
          Images: { Image: ['https://img.test/den.jpg'] },
          quantity: '5',
          price: '199000',
          package_weight: '0.2',
          package_length: '20',
          package_width: '15',
          package_height: '3',
        },
        {
          SellerSku: 'CM-TRANG-S',
          saleProp: { color_family: 'Trắng', size: 'Int:S' },
          Images: { Image: ['https://img.test/trang.jpg'] },
          quantity: '5',
          price: '199000',
          package_weight: '0.2',
          package_length: '20',
          package_width: '15',
          package_height: '3',
        },
      ],
    });
  });

  it('trục tự đặt tên (code null): customize true, name là tên trục; trục không ảnh thì hasImage false', async () => {
    const fn = fakeFetch(none, { code: '0', data: { item_id: '1', item_status: 'Pending QC', sku_list: [{ seller_sku: 'A', sku_id: '10' }, { seller_sku: 'B', sku_id: '11' }] } });
    const p: NewProduct = {
      ...base,
      salesAttributes: [{ code: null, name: 'Mùi', values: [{ optionId: null, label: 'Hồng' }, { optionId: null, label: 'Cam' }] }],
      skus: [
        { sellerSku: 'A', price: '1', values: ['Hồng'], ...dims },
        { sellerSku: 'B', price: '1', values: ['Cam'], ...dims },
      ],
    };
    const created = await createLazadaAdapter(config, fn).createProduct('t', p);
    expect(created.live).toBe(false);
    const product = payloadOf(fn, 1).Request.Product as { variation: unknown; Skus: { Sku: { saleProp: unknown; Images?: unknown }[] } };
    expect(product.variation).toEqual({ variation1: { name: 'Mùi', hasImage: false, customize: true, options: { option: ['Hồng', 'Cam'] } } });
    expect(product.Skus.Sku[0]).toMatchObject({ saleProp: { Mùi: 'Hồng' } });
    expect(product.Skus.Sku[0]).not.toHaveProperty('Images');
  });

  it('một SKU không gửi variation, saleProp (body như cũ) và không trả skus', async () => {
    const fn = fakeFetch(none, { code: '0', data: { item_id: '5', item_status: 'Active', sku_list: [{ sku_id: '50' }] } });
    const created = await createLazadaAdapter(config, fn).createProduct('t', base);
    expect(created).toEqual({ externalProductId: '5', externalSkuId: '50', live: true });
    const product = payloadOf(fn, 1).Request.Product as { Skus: { Sku: object[] } };
    expect(product).not.toHaveProperty('Variation');
    expect(product).not.toHaveProperty('variation');
    expect(product.Skus.Sku[0]).toEqual({ SellerSku: 'CM-DEN-S', price: '199000', package_weight: '0.2', package_length: '20', package_width: '15', package_height: '3' });
  });

  it('thiếu một SKU trong phản hồi: unexpected_response (SKU đầu) hoặc skus chỉ có SKU sàn nhận', async () => {
    const fn = fakeFetch(none, { code: '0', data: { item_id: '1', item_status: 'Active', sku_list: [{ seller_sku: 'CM-TRANG-S', sku_id: '2' }] } });
    await expect(createLazadaAdapter(config, fn).createProduct('t', multi)).rejects.toMatchObject({ platformCode: 'unexpected_response' });
  });

  it('chống trùng: thấy mọi SKU cùng một sản phẩm thì existing: true kèm skus', async () => {
    const fn = fakeFetch({ code: '0', data: { products: [{ ...row('77', 'Pending QC', [{ id: 770, sku: 'CM-DEN-S' }, { id: 771, sku: 'CM-TRANG-S' }]), created_time: '1795000000000' }] } });
    const created = await createLazadaAdapter(config, fn).createProduct('t', multi);
    expect(created).toEqual({
      externalProductId: '77',
      externalSkuId: '770',
      live: false,
      existing: true,
      createdAt: new Date(1795000000000),
      title: 'SP',
      skus: [
        { sellerSku: 'CM-DEN-S', externalSkuId: '770' },
        { sellerSku: 'CM-TRANG-S', externalSkuId: '771' },
      ],
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('chống trùng: chỉ thấy một phần SKU thì sku_exists_on_platform, không tạo', async () => {
    const fn = fakeFetch({ code: '0', data: { products: [row('77', 'Active', [{ id: 770, sku: 'CM-DEN-S' }])] } });
    await expect(createLazadaAdapter(config, fn).createProduct('t', multi)).rejects.toMatchObject({
      kind: 'rejected',
      platformCode: 'sku_exists_on_platform',
      platformMessage: expect.stringContaining('CM-TRANG-S'),
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('chống trùng: các SKU thuộc hai sản phẩm khác nhau thì sku_exists_on_platform', async () => {
    const fn = fakeFetch({ code: '0', data: { products: [row('77', 'Active', [{ id: 770, sku: 'CM-DEN-S' }]), row('78', 'Active', [{ id: 780, sku: 'CM-TRANG-S' }])] } });
    await expect(createLazadaAdapter(config, fn).createProduct('t', multi)).rejects.toMatchObject({ platformCode: 'sku_exists_on_platform' });
  });
});

describe('Lazada addVariants', () => {
  const input: NewVariants = { ...multi, skus: [{ sellerSku: 'CM-DO-S', price: '199000', quantity: 3, values: ['Đỏ', 'Int:S'], ...dims }], salesAttributes: [
    { code: 'color_family', name: 'Màu', values: [{ optionId: null, label: 'Đỏ', imageUri: 'https://img.test/do.jpg' }] },
    salesAttributes[1]!,
  ] };
  const itemGet = { code: '0', data: { status: 'Active', skus: [{ SkuId: 117597811498, SellerSku: 'CM-DEN-S' }, { SkuId: 117597811499, SellerSku: 'CM-TRANG-S' }] } };

  it('AssociatedSku là sku_id đọc từ item (không phải item_id), khai báo variation chỉ giá trị mới, chỉ gửi SKU mới; ghép theo seller_sku', async () => {
    const fn = fakeFetch(itemGet, {
      code: '0',
      data: {
        item_id: 13517941999,
        item_status: 'Active',
        sku_list: [
          { seller_sku: 'CM-DEN-S', sku_id: 117597811498 },
          { seller_sku: 'CM-DO-S', sku_id: 117617144674 },
        ],
      },
    });
    const result = await createLazadaAdapter(config, fn).addVariants!('t', '13517941999', input);
    expect(result).toEqual({ skus: [{ sellerSku: 'CM-DO-S', externalSkuId: '117617144674' }], live: true });
    expect(sent(fn, 0)).toMatchObject({ path: '/rest/product/item/get', query: { item_id: '13517941999' } });
    const product = payloadOf(fn, 1).Request.Product as { AssociatedSku: string; variation: unknown; Skus: { Sku: { SellerSku: string; Images?: unknown }[] } };
    expect(product.AssociatedSku).toBe('117597811498');
    expect(product.AssociatedSku).not.toBe('13517941999');
    // Không khai báo thì sản phẩm có tên tự đặt bị từ chối (#572, request_id d742e42a17955177348851472)
    expect(product.variation).toEqual({
      variation1: { name: 'color_family', hasImage: true, customize: false, options: { option: ['Đỏ'] } },
      variation2: { name: 'size', hasImage: false, customize: false, options: { option: ['Int:S'] } },
    });
    expect(product.Skus.Sku).toHaveLength(1);
    expect(product.Skus.Sku[0]).toMatchObject({ SellerSku: 'CM-DO-S', saleProp: { color_family: 'Đỏ', size: 'Int:S' }, Images: { Image: ['https://img.test/do.jpg'] } });
  });

  it('BẪY: sàn trả item_id khác (tạo item mới) thì xoá SKU của item lạ rồi ném associated_item_mismatch', async () => {
    const fn = fakeFetch(
      itemGet,
      { code: '0', data: { item_id: 13518063037, item_status: 'Active', sku_list: [{ seller_sku: 'CM-DO-S', sku_id: 999 }] } },
      { code: '0' },
    );
    await expect(createLazadaAdapter(config, fn).addVariants!('t', '13517941999', input)).rejects.toMatchObject({
      kind: 'rejected',
      platformCode: 'associated_item_mismatch',
    });
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sent(fn, 2)).toMatchObject({ path: '/rest/product/remove', method: 'POST' });
    expect(sent(fn, 2).body.sku_id_list).toBe('["SkuId_13518063037_999"]');
  });

  it('item không còn SKU nào để làm AssociatedSku thì sku_not_found, không gọi create', async () => {
    const fn = fakeFetch({ code: '0', data: { status: 'Active', skus: [] } });
    await expect(createLazadaAdapter(config, fn).addVariants!('t', '1', input)).rejects.toMatchObject({ platformCode: 'sku_not_found' });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('Lazada removeVariants', () => {
  const item = (skus: { SkuId: number; Status: string }[]) => ({ code: '0', data: { status: 'Active', skus } });

  it('đọc item trước, còn SKU khác thì gọi remove với sku_id_list là JSON mảng SkuId_<item>_<sku>', async () => {
    const fn = fakeFetch(
      item([{ SkuId: 117597811499, Status: 'active' }, { SkuId: 117617144674, Status: 'inactive' }, { SkuId: 1, Status: 'active' }]),
      { code: '0' },
    );
    await createLazadaAdapter(config, fn).removeVariants!('t', '13517941999', ['117597811499', '117617144674']);
    expect(sent(fn, 0)).toMatchObject({ path: '/rest/product/item/get' });
    expect(sent(fn, 1)).toMatchObject({ path: '/rest/product/remove', method: 'POST' });
    expect(sent(fn, 1).body.sku_id_list).toBe('["SkuId_13517941999_117597811499","SkuId_13517941999_117617144674"]');
  });

  it('SKU gỡ là SKU cuối chưa xoá trên sàn (bản sao của app cũ): last_variant, không gọi remove vì sàn sẽ xoá cả item', async () => {
    const fn = fakeFetch(item([{ SkuId: 117617380384, Status: 'active' }, { SkuId: 117617380385, Status: 'deleted' }]));
    await expect(createLazadaAdapter(config, fn).removeVariants!('t', '13518099452', ['117617380384'])).rejects.toMatchObject({
      kind: 'rejected',
      platformCode: 'last_variant',
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('Lazada: sale prop chuẩn size không mang ảnh (#568, VARIATION_CATEGORY_SIZE_IMAGE)', () => {
  const sizeAxis: SalesAttribute = {
    code: 'size',
    name: 'Kích cỡ',
    values: [
      { optionId: null, label: 'Đen - S', imageUri: 'img-den' },
      { optionId: null, label: 'Trắng - S', imageUri: 'img-trang' },
    ],
  };
  const sku = { sellerSku: 'SKU-1', price: '100000', values: ['Đen - S'], weightG: 300, lengthMm: 100, widthMm: 100, heightMm: 100 };

  it('thuộc tính biến thể ghép đích size: hasImage false, SKU không gửi Images', () => {
    expect(lazadaVariation([sizeAxis])).toEqual({
      variation1: { name: 'size', hasImage: false, customize: false, options: { option: ['Đen - S', 'Trắng - S'] } },
    });
    expect(lazadaSkuIdentity(sku, [sizeAxis])).toEqual({ SellerSku: 'SKU-1', saleProp: { size: 'Đen - S' } });
  });

  it('đích khác size vẫn gửi ảnh', () => {
    const color = { ...sizeAxis, code: 'color_family' };
    expect(lazadaVariation([color])['variation1']).toMatchObject({ hasImage: true });
    expect(lazadaSkuIdentity(sku, [color])).toMatchObject({ Images: { Image: ['img-den'] } });
  });
});

describe('Lazada: thứ tự khai báo và thêm phân loại (#572)', () => {
  const size: SalesAttribute = { code: 'smartwear_size', name: 'Cỡ', values: [{ optionId: null, label: 'M' }, { optionId: null, label: 'L' }] };
  const color: SalesAttribute = {
    code: 'color_family',
    name: 'Màu',
    values: [
      { optionId: null, label: 'Đen', imageUri: 'img-den' },
      { optionId: null, label: 'Trắng', imageUri: 'img-trang' },
    ],
  };
  const custom: SalesAttribute = { code: null, name: 'Phần', values: [{ optionId: null, label: 'Đùi' }, { optionId: null, label: 'Ức' }] };
  const sku = (values: string[]) => ({ sellerSku: values.join('-'), price: '100000', values, weightG: 300, lengthMm: 100, widthMm: 100, heightMm: 100 });

  it('thuộc tính gắn ảnh đứng sau thì đưa lên variation1 (VARIATION_IMAGE_MUST_SET_VARIATION1); saleProp vẫn theo tên', () => {
    expect(lazadaVariation([size, color])).toEqual({
      variation1: { name: 'color_family', hasImage: true, customize: false, options: { option: ['Đen', 'Trắng'] } },
      variation2: { name: 'smartwear_size', hasImage: false, customize: false, options: { option: ['M', 'L'] } },
    });
    expect(lazadaSkuIdentity(sku(['L', 'Trắng']), [size, color])).toEqual({
      SellerSku: 'L-Trắng',
      saleProp: { smartwear_size: 'L', color_family: 'Trắng' },
      Images: { Image: ['img-trang'] },
    });
  });

  it('sale prop chuẩn luôn customize false kể cả giá trị ngoài lựa chọn; tên tự đặt customize true', () => {
    expect(lazadaVariation([{ ...color, values: [{ optionId: null, label: 'Đỏ - S' }] }, custom])).toEqual({
      variation1: { name: 'color_family', hasImage: false, customize: false, options: { option: ['Đỏ - S'] } },
      variation2: { name: 'Phần', hasImage: false, customize: true, options: { option: ['Đùi', 'Ức'] } },
    });
  });

  it('thêm phân loại: thứ tự, hasImage theo cả sản phẩm, lựa chọn chỉ giá trị các SKU mới dùng', () => {
    // SKU mới chỉ dùng "M" và "Trắng": thuộc tính ảnh vẫn đứng đầu, hasImage giữ như lúc tạo
    expect(lazadaAddVariation([size, color], [sku(['M', 'Trắng'])])).toEqual({
      variation1: { name: 'color_family', hasImage: true, customize: false, options: { option: ['Trắng'] } },
      variation2: { name: 'smartwear_size', hasImage: false, customize: false, options: { option: ['M'] } },
    });
    expect(lazadaAddVariation([custom], [sku(['Ức'])])).toEqual({
      variation1: { name: 'Phần', hasImage: false, customize: true, options: { option: ['Ức'] } },
    });
  });
});
