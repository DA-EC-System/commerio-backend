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

describe('Lazada: đếm hàng lúc nối bằng `total_products` (#198/#284 §18.7.4)', () => {
  it('một lời gọi `/products/get` với `filter=all`, `limit=1`, trả `total_products` dạng số như gọi thật', async () => {
    const calls: URLSearchParams[] = [];
    const total = await createLazadaAdapter(config, fakeLazada({ total_products: 305, products: [product] }, calls)).countSkus!('t');
    expect(total).toBe(305);
    expect(calls).toHaveLength(1);
    expect([calls[0]!.get('filter'), calls[0]!.get('limit'), calls[0]!.get('offset')]).toEqual(['all', '1', '0']);
  });

  it('đọc được `total_products` dạng chuỗi như response mẫu của tài liệu', async () => {
    expect(await createLazadaAdapter(config, fakeLazada({ total_products: '10', products: [product] })).countSkus!('t')).toBe(10);
  });

  it('gian hàng không có sản phẩm: sàn bỏ `total_products`, trả 0', async () => {
    expect(await createLazadaAdapter(config, fakeLazada({ products: [] })).countSkus!('t')).toBe(0);
    expect(await createLazadaAdapter(config, fakeLazada({})).countSkus!('t')).toBe(0);
  });

  it.each([
    ['thiếu tổng mà có sản phẩm', { products: [product] }],
    ['tổng âm', { total_products: -1, products: [] }],
    ['tổng không phải số', { total_products: 'abc', products: [] }],
    ['tổng lẻ', { total_products: 1.5, products: [] }],
  ])('%s thì báo `unexpected_response`, không đoán số', async (_name, data) => {
    await expect(createLazadaAdapter(config, fakeLazada(data)).countSkus!('t')).rejects.toMatchObject({
      kind: 'rejected',
      platformCode: 'unexpected_response',
    });
  });

  it('lỗi của sàn đi qua cách đổi lỗi chung', async () => {
    const fetchFn = async () => new Response(JSON.stringify({ code: 'IllegalAccessToken', type: 'ISV', message: 'bad', request_id: 'r' }), { status: 200 });
    await expect(createLazadaAdapter(config, fetchFn).countSkus!('t')).rejects.toMatchObject({ kind: 'unauthorized' });
  });
});
