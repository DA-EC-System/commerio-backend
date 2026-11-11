import { describe, expect, it } from 'vitest';
import { createLazadaAdapter } from '#src/modules/channel/channel/service/marketplaces/lazada.ts';

const config = { appKey: 'k', appSecret: 's', redirectUrl: 'https://app/cb', apiUrl: 'https://api.test/rest', authUrl: 'https://auth.test' };

// GetProducts (open.lazada.com, tra 10/11/2026): `total_products` chỉ có ở response mẫu, dạng chuỗi. Gọi thật 10/11/2026 trên
// shop thử: dạng số, theo `filter`, `all` không gồm sản phẩm đã xoá, không có sản phẩm nào thì sàn bỏ trường.
function fakeLazada(data: unknown, calls: URLSearchParams[] = []) {
  return async (url: string | URL | Request) => {
    calls.push(new URL(String(url)).searchParams);
    return new Response(JSON.stringify({ code: '0', data, request_id: 'r' }), { status: 200 });
  };
}

const product = { item_id: '180226526', status: 'Active', skus: [{ SkuId: 314525867, SellerSku: '39817:01:01' }] };

// `total_products` là số sản phẩm, không phải số SKU; Lazada không trả tổng số SKU nên `skuCount` luôn null.
describe('Lazada: đếm sản phẩm lúc nối bằng `total_products`, số phân loại null (`countRemote`, #198/#284 §18.7.4)', () => {
  it('một lời gọi `/products/get` với `filter=all`, `limit=1`: `productCount` là `total_products` (dạng số như gọi thật), `skuCount` null', async () => {
    const calls: URLSearchParams[] = [];
    const total = await createLazadaAdapter(config, fakeLazada({ total_products: 305, products: [product] }, calls)).countRemote!('t');
    expect(total).toEqual({ productCount: 305, skuCount: null });
    expect(calls).toHaveLength(1);
    expect([calls[0]!.get('filter'), calls[0]!.get('limit'), calls[0]!.get('offset')]).toEqual(['all', '1', '0']);
  });

  it('đọc được `total_products` dạng chuỗi như response mẫu của tài liệu', async () => {
    expect(await createLazadaAdapter(config, fakeLazada({ total_products: '10', products: [product] })).countRemote!('t')).toEqual({ productCount: 10, skuCount: null });
  });

  it('gian hàng không có sản phẩm: sàn bỏ `total_products`, số sản phẩm là 0, số phân loại vẫn null', async () => {
    expect(await createLazadaAdapter(config, fakeLazada({ products: [] })).countRemote!('t')).toEqual({ productCount: 0, skuCount: null });
    expect(await createLazadaAdapter(config, fakeLazada({})).countRemote!('t')).toEqual({ productCount: 0, skuCount: null });
  });

  // Hợp đồng §18.7.4: BE không trả 0 thay cho lỗi. Sàn bỏ `total_products` khi không có sản phẩm thì `data` vẫn là object.
  it.each([
    ['vắng', undefined],
    ['null', null],
    ['chuỗi', 'oops'],
    ['mảng', []],
  ])('phản hồi thành công mà `data` %s thì `unexpected_response`, không coi là 0', async (_name, data) => {
    await expect(createLazadaAdapter(config, fakeLazada(data)).countRemote!('t')).rejects.toMatchObject({
      kind: 'rejected',
      platformCode: 'unexpected_response',
    });
  });

  it.each([
    ['thiếu tổng mà có sản phẩm', { products: [product] }],
    ['tổng âm', { total_products: -1, products: [] }],
    ['tổng không phải số', { total_products: 'abc', products: [] }],
    ['tổng lẻ', { total_products: 1.5, products: [] }],
  ])('%s thì báo `unexpected_response`, không đoán số', async (_name, data) => {
    await expect(createLazadaAdapter(config, fakeLazada(data)).countRemote!('t')).rejects.toMatchObject({
      kind: 'rejected',
      platformCode: 'unexpected_response',
    });
  });

  it('lỗi của sàn đi qua cách đổi lỗi chung', async () => {
    const fetchFn = async () => new Response(JSON.stringify({ code: 'IllegalAccessToken', type: 'ISV', message: 'bad', request_id: 'r' }), { status: 200 });
    await expect(createLazadaAdapter(config, fetchFn).countRemote!('t')).rejects.toMatchObject({ kind: 'unauthorized' });
  });
});
