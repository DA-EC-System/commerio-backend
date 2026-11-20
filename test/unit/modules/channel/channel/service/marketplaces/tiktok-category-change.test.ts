// Đổi category trên TikTok (commerio-backend#467, Documents/21 §18.5): body Edit Product 202509 dựng từ Get Product 202309,
// so hai lần đọc, và `changeCategory` của adapter với sàn giả theo đường dẫn API.
import { describe, expect, it, vi } from 'vitest';
import { createTiktokClient, packTiktokToken } from '#src/modules/channel/channel/service/marketplaces/tiktok-client.ts';
import {
  tiktokCategoryEditBody,
  tiktokCategoryMismatch,
} from '#src/modules/channel/channel/service/marketplaces/tiktok-category-change.ts';
import { tiktokListingMethods } from '#src/modules/channel/channel/service/marketplaces/tiktok-listing.ts';

const OPTS = { categoryVersion: 'v2', currency: 'VND' };

/** Sản phẩm đang bán như Get Product 202309 trả (rút gọn theo OAS): 3 SKU, 2 ảnh, đủ trường app không quản. */
const product = () => ({
  id: 'P1',
  status: 'ACTIVATE',
  title: 'Áo thun cotton nam cổ tròn màu đen',
  description: '<p>Áo của người bán</p>',
  category_chains: [
    { id: '100', parent_id: '0', is_leaf: false },
    { id: '600001', parent_id: '100', is_leaf: true },
  ],
  brand: { id: 'B7', name: 'Hiệu A' },
  main_images: [
    { uri: 'tos/img-1', urls: ['https://cdn/1'] },
    { uri: 'tos/img-2', urls: ['https://cdn/2'] },
  ],
  video: { id: 'v09', cover_url: 'https://cdn/v' },
  package_dimensions: { length: '30', width: '20', height: '2', unit: 'CENTIMETER' },
  package_weight: { value: '0.25', unit: 'KILOGRAM' },
  size_chart: { image: { uri: 'tos/size', urls: ['https://cdn/s'] } },
  delivery_options: [
    { id: 'D1', is_available: true },
    { id: 'D2', is_available: false },
  ],
  is_cod_allowed: true,
  certifications: [{ id: 'C1', title: 'CQ', images: [{ uri: 'tos/cert', urls: ['x'] }], files: [{ id: 'F1', name: 'cq.pdf', format: 'PDF', urls: ['y'] }] }],
  product_attributes: [{ id: '100107', name: 'Chất liệu', values: [{ id: '1', name: 'Len' }] }],
  skus: [
    {
      id: 'S1',
      seller_sku: 'AO-DEN-M',
      price: { sale_price: '150000', currency: 'VND', tax_exclusive_price: '150000' },
      inventory: [{ warehouse_id: 'W1', quantity: 7 }],
      sales_attributes: [{ id: '100000', name: 'Size', value_id: '9', value_name: 'M', sku_img: { uri: 'tos/sku-m', urls: ['z'] } }],
      identifier_code: { code: '8930000000011', type: 'EAN' },
    },
    {
      id: 'S2',
      seller_sku: 'AO-DEN-L',
      price: { sale_price: '160000', currency: 'VND' },
      inventory: [{ warehouse_id: 'W1', quantity: 3 }],
      sales_attributes: [{ id: '100000', name: 'Size', value_id: '10', value_name: 'L' }],
    },
    {
      id: 'S3',
      seller_sku: 'AO-DEN-XL',
      price: { sale_price: '170000', currency: 'VND' },
      inventory: [{ warehouse_id: 'W1', quantity: 0 }],
      sales_attributes: [{ id: '100000', name: 'Size', value_id: '11', value_name: 'XL' }],
    },
  ],
});

const ATTRS = [{ id: '101400', values: [{ id: '55' }] }, { id: '100149', values: [{ name: 'Việt Nam' }] }];

describe('tiktokCategoryEditBody', () => {
  it('chép mọi SKU (không gửi giá), ảnh, kích thước, thương hiệu, bảng size, cách giao, COD, video, chứng nhận; chỉ đổi category_id và product_attributes', () => {
    const body = tiktokCategoryEditBody(product(), { externalCategoryId: '600777' }, ATTRS, OPTS);
    expect(body).toEqual({
      save_mode: 'LISTING',
      title: 'Áo thun cotton nam cổ tròn màu đen',
      description: '<p>Áo của người bán</p>',
      category_id: '600777',
      category_version: 'v2',
      main_images: [{ uri: 'tos/img-1' }, { uri: 'tos/img-2' }],
      package_dimensions: { length: '30', width: '20', height: '2', unit: 'CENTIMETER' },
      package_weight: { value: '0.25', unit: 'KILOGRAM' },
      brand_id: 'B7',
      size_chart: { image: { uri: 'tos/size' } },
      delivery_option_ids: ['D1'],
      is_cod_allowed: true,
      video: { id: 'v09' },
      certifications: [{ id: 'C1', images: [{ uri: 'tos/cert' }], files: [{ id: 'F1', name: 'cq.pdf', format: 'PDF' }] }],
      product_attributes: ATTRS,
      skus: [
        {
          id: 'S1',
          seller_sku: 'AO-DEN-M',
          sales_attributes: [{ id: '100000', name: 'Size', value_id: '9', value_name: 'M', sku_img: { uri: 'tos/sku-m' } }],
          identifier_code: { code: '8930000000011', type: 'EAN' },
        },
        {
          id: 'S2',
          seller_sku: 'AO-DEN-L',
          sales_attributes: [{ id: '100000', name: 'Size', value_id: '10', value_name: 'L' }],
        },
        {
          id: 'S3',
          seller_sku: 'AO-DEN-XL',
          sales_attributes: [{ id: '100000', name: 'Size', value_id: '11', value_name: 'XL' }],
        },
      ],
    });
  });

  it('không gửi giá SKU (OAS: bỏ thì giữ giá cũ, tránh đè lượt đẩy giá chạy đồng thời)', () => {
    const body = tiktokCategoryEditBody(product(), { externalCategoryId: '600777' }, [], OPTS);
    expect((body.skus as Record<string, unknown>[]).every((s) => !('price' in s))).toBe(true);
  });

  it('chép thêm shipping_template_id và combined_skus, fees, external_urls, sku_unit_count, external_list_prices của SKU', () => {
    const p = product() as Record<string, unknown> & { skus: Record<string, unknown>[] };
    p.shipping_template_id = 'ST1';
    Object.assign(p.skus[0]!, {
      combined_skus: [{ product_id: 'P8', sku_id: 'S8', sku_count: 2, title: 'chỉ đọc', price: { sale_price: '1' } }],
      fees: [{ type: 'PFAND', amount: '1000', additional_attribute: 'SINGLE_USE' }],
      external_urls: ['https://example.com/a'],
      sku_unit_count: '500',
      external_list_prices: [{ amount: '200000', currency: 'VND', source: 'SHOPEE' }],
    });
    const body = tiktokCategoryEditBody(p, { externalCategoryId: '600777' }, [], OPTS);
    expect(body.shipping_template_id).toBe('ST1');
    expect((body.skus as Record<string, unknown>[])[0]).toMatchObject({
      combined_skus: [{ product_id: 'P8', sku_id: 'S8', sku_count: 2 }],
      fees: [{ type: 'PFAND', amount: '1000', additional_attribute: 'SINGLE_USE' }],
      external_urls: ['https://example.com/a'],
      sku_unit_count: '500',
      external_list_prices: [{ amount: '200000', currency: 'VND', source: 'SHOPEE' }],
    });
    expect(body).not.toHaveProperty('listing_platforms');
  });

  it('không gửi tồn (OAS: bỏ `inventory` thì giữ tồn cũ) và không mang attribute cũ của sản phẩm', () => {
    const body = tiktokCategoryEditBody(product(), { externalCategoryId: '600777' }, [], OPTS);
    expect((body.skus as Record<string, unknown>[]).every((s) => !('inventory' in s))).toBe(true);
    expect(body).not.toHaveProperty('product_attributes');
  });

  it('bảng size: giữ mẫu của sàn trước ảnh; sản phẩm chưa có bảng size thì dùng ảnh của app', () => {
    const withTemplate = { ...product(), size_chart: { template: { id: 'T1' }, image: { uri: 'tos/size' } } };
    expect(tiktokCategoryEditBody(withTemplate, { externalCategoryId: '1', sizeChartUri: 'tos/app' }, [], OPTS).size_chart).toEqual({ template: { id: 'T1' } });
    expect(tiktokCategoryEditBody(product(), { externalCategoryId: '1', sizeChartUri: 'tos/app' }, [], OPTS).size_chart).toEqual({ image: { uri: 'tos/size' } });
    const none = { ...product(), size_chart: undefined };
    expect(tiktokCategoryEditBody(none, { externalCategoryId: '1', sizeChartUri: 'tos/app' }, [], OPTS).size_chart).toEqual({ image: { uri: 'tos/app' } });
    expect(tiktokCategoryEditBody(none, { externalCategoryId: '1' }, [], OPTS)).not.toHaveProperty('size_chart');
  });
});

describe('tiktokCategoryMismatch', () => {
  it('khớp số SKU, SKU người bán, giá, số ảnh thì rỗng (giá so theo số)', () => {
    const after = product();
    after.skus[0]!.price.sale_price = '150000.00';
    expect(tiktokCategoryMismatch(product(), after)).toEqual([]);
  });

  it('mất SKU thì ghi số còn lại và SKU thiếu', () => {
    const after = product();
    after.skus.pop();
    expect(tiktokCategoryMismatch(product(), after)).toEqual(['còn 2/3 SKU: thiếu AO-DEN-XL']);
  });

  it('đổi giá, thêm SKU, thiếu ảnh đều được liệt kê', () => {
    const after = product();
    after.skus[1]!.price.sale_price = '0';
    after.skus.push({ ...after.skus[2]!, id: 'S4', seller_sku: 'AO-DEN-XXL' });
    after.main_images.pop();
    expect(tiktokCategoryMismatch(product(), after)).toEqual([
      'còn 4/3 SKU',
      'có thêm SKU AO-DEN-XXL',
      'đổi giá SKU AO-DEN-L: 160000 → 0',
      'còn 1/2 ảnh',
    ]);
  });
});

describe('changeCategory (adapter TikTok)', () => {
  const config = { appKey: 'appk', appSecret: 'apps', serviceId: undefined, apiUrl: 'https://open.test', authUrl: 'https://auth.test' };
  const TOKEN = packTiktokToken({ token: 'TTP_at', cipher: 'ROW_c', shopId: '749' });
  const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, message: 'Success', request_id: 'r', data }));

  /** Sàn giả: Get Product trả `live` (bản đang bán) hoặc `review` (khi có `return_under_review_version`); ghi mọi lời gọi. */
  function fakeSan(live: Record<string, unknown>, review: Record<string, unknown> | null) {
    const calls: { method: string; path: string; query: URLSearchParams; body: unknown }[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      const u = new URL(String(input));
      const method = init?.method ?? 'GET';
      calls.push({ method, path: u.pathname, query: u.searchParams, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
      if (method === 'GET' && u.pathname === '/product/202309/products/P1') {
        if (u.searchParams.get('return_under_review_version') === 'true') {
          return review ? ok(review) : new Response(JSON.stringify({ code: 12052547, message: 'no under review version', request_id: 'r', data: null }));
        }
        return ok(live);
      }
      if (method === 'GET' && u.pathname === '/product/202309/categories/600777/attributes') {
        return ok({ attributes: [{ id: '101400', name: 'Kiểu cổ', values: [{ id: '55', name: 'Cổ tròn' }] }] });
      }
      if (method === 'PUT' && u.pathname === '/product/202509/products/P1') return ok({ product_id: 'P1' });
      return new Response(JSON.stringify({ code: 36009009, message: 'Invalid path', request_id: 'r', data: null }));
    });
    return { calls, methods: tiktokListingMethods(createTiktokClient(config, fetchFn)) };
  }

  it('PUT body dựng từ Get Product, attribute đổi sang mã sàn; không bật, tắt sản phẩm; đọc lại khớp thì không lệch', async () => {
    const san = fakeSan(product(), { ...product(), status: 'PENDING' });
    const result = await san.methods.changeCategory!(TOKEN, 'P1', { externalCategoryId: '600777', attributes: { '101400': 'Cổ tròn' } });
    expect(result).toEqual({ underReview: false, mismatch: [] });
    const put = san.calls.find((c) => c.method === 'PUT')!;
    expect(put.body).toMatchObject({ category_id: '600777', product_attributes: [{ id: '101400', values: [{ id: '55' }] }] });
    expect((put.body as { skus: unknown[] }).skus).toHaveLength(3);
    expect(san.calls.some((c) => c.path.endsWith('/activate') || c.path.endsWith('/deactivate'))).toBe(false);
    expect(san.calls.some((c) => c.method === 'GET' && c.query.get('return_under_review_version') === 'true')).toBe(true);
  });

  it('bản đang duyệt mất SKU thì trả chỗ lệch; bản đang bán `PENDING` thì `underReview`', async () => {
    const review = product();
    review.skus.pop();
    const san = fakeSan({ ...product(), status: 'PENDING' }, review);
    const result = await san.methods.changeCategory!(TOKEN, 'P1', { externalCategoryId: '600777', attributes: {} });
    expect(result).toEqual({ underReview: true, mismatch: ['còn 2/3 SKU: thiếu AO-DEN-XL'] });
  });

  it('không còn bản đang duyệt (12052547) thì so với bản đang bán', async () => {
    const san = fakeSan(product(), null);
    const result = await san.methods.changeCategory!(TOKEN, 'P1', { externalCategoryId: '600777', attributes: {} });
    expect(result.mismatch).toEqual([]);
  });
});
