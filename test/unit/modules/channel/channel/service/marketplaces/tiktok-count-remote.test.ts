import { describe, expect, it, vi } from 'vitest';
import { packTiktokToken } from '#src/modules/channel/channel/service/marketplaces/tiktok-client.ts';
import { createTiktokAdapter } from '#src/modules/channel/channel/service/marketplaces/tiktok.ts';

const config = { appKey: 'appk', appSecret: 'apps', serviceId: undefined, apiUrl: 'https://open.test', authUrl: 'https://auth.test' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ok = (data: unknown) => json({ code: 0, message: 'Success', request_id: 'r', data });
const token = packTiktokToken({ token: 'TTP_at', cipher: 'ROW_cipher', shopId: '7495013067939481105' });

function fakeFetch(...responses: Response[]) {
  const fn = vi.fn<typeof fetch>();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  return fn;
}
const urlOf = (fn: ReturnType<typeof fakeFetch>, i: number) => new URL(String(fn.mock.calls[i]?.[0]));
const bodyOf = (fn: ReturnType<typeof fakeFetch>, i: number) => (fn.mock.calls[i]?.[1] as RequestInit).body;

const sku = (id: string) => ({ id, seller_sku: `SKU-${id}`, inventory: [{ quantity: 1, warehouse_id: 'w1' }] });
const product = (id: string, status: string, skus: object[]) => ({ id, title: `SP ${id}`, status, skus });
const fullPage = () => Array.from({ length: 100 }, (_, i) => product(String(i + 1), 'ACTIVATE', [sku(`${i + 1}1`)]));

// Search Products 202502 (docv2, OAS, tra 11/11/2026): `data` chỉ có `total_count` (số sản phẩm khớp điều kiện lọc),
// `products`, `next_page_token`; không có tổng số SKU. Gọi thật 11/11/2026 trên shop thử VN: `status: ALL` trả
// `total_count` 5 = `ACTIVATE` 2 + `DELETED` 3 (có tính sản phẩm đã xoá), `status: DELETED` trả 3; `total_count` dạng số;
// `next_page_token` khác rỗng cả khi trang đầu đã hết.
describe('TikTok: đếm sản phẩm và phân loại lúc nối (`countRemote`, §18.7.4)', () => {
  it('trang đầu chứa hết gian hàng: một lời gọi, trả cả hai số, bỏ sản phẩm `DELETED` và SKU của nó', async () => {
    const fetchFn = fakeFetch(
      ok({
        total_count: 5,
        next_page_token: '',
        products: [
          product('1', 'ACTIVATE', [sku('11'), sku('12')]),
          product('2', 'ACTIVATE', [sku('21')]),
          product('3', 'DELETED', [sku('31')]),
          product('4', 'DELETED', [sku('41'), sku('42')]),
          product('5', 'DELETED', [sku('51')]),
        ],
      }),
    );
    expect(await createTiktokAdapter(config, fetchFn).countRemote!(token)).toEqual({ productCount: 2, skuCount: 3 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(urlOf(fetchFn, 0).pathname).toBe('/product/202502/products/search');
    expect(urlOf(fetchFn, 0).searchParams.get('page_size')).toBe('100');
    expect(urlOf(fetchFn, 0).searchParams.has('page_token')).toBe(false);
    expect(bodyOf(fetchFn, 0)).toBe('{"status":"ALL"}');
  });

  it('`next_page_token` khác rỗng mà `total_count` không quá số sản phẩm của trang: vẫn coi là hết, không gọi thêm', async () => {
    const fetchFn = fakeFetch(ok({ total_count: 2, next_page_token: 'p2', products: [product('1', 'ACTIVATE', [sku('11'), sku('12')]), product('2', 'PENDING', [sku('21')])] }));
    expect(await createTiktokAdapter(config, fetchFn).countRemote!(token)).toEqual({ productCount: 2, skuCount: 3 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('gian hàng không có sản phẩm: cả hai số là 0', async () => {
    expect(await createTiktokAdapter(config, fakeFetch(ok({ total_count: 0, products: [] }))).countRemote!(token)).toEqual({ productCount: 0, skuCount: 0 });
    expect(await createTiktokAdapter(config, fakeFetch(ok({}))).countRemote!(token)).toEqual({ productCount: 0, skuCount: 0 });
  });

  it('hơn một trang: `skuCount` null, số sản phẩm trừ số đã xoá bằng lời gọi `DELETED` `page_size` 1; không lật trang', async () => {
    const fetchFn = fakeFetch(
      ok({ total_count: 305, next_page_token: 'p2', products: fullPage() }),
      ok({ total_count: 96, next_page_token: 'd2', products: [product('900', 'DELETED', [sku('9001')])] }),
    );
    expect(await createTiktokAdapter(config, fetchFn).countRemote!(token)).toEqual({ productCount: 209, skuCount: null });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchFn, 1)).toBe('{"status":"DELETED"}');
    expect(urlOf(fetchFn, 1).searchParams.get('page_size')).toBe('1');
    expect(urlOf(fetchFn, 1).searchParams.has('page_token')).toBe(false);
  });

  it('hơn một trang, không có sản phẩm đã xoá: số sản phẩm là `total_count`', async () => {
    const fetchFn = fakeFetch(ok({ total_count: 101, next_page_token: 'p2', products: fullPage() }), ok({ total_count: 0, products: [] }));
    expect(await createTiktokAdapter(config, fetchFn).countRemote!(token)).toEqual({ productCount: 101, skuCount: null });
  });

  it('hơn 10000 sản phẩm không ném `too_many_products`: vẫn có số sản phẩm', async () => {
    const fetchFn = fakeFetch(ok({ total_count: 10_500, next_page_token: 'p2', products: fullPage() }), ok({ total_count: 500, products: [product('900', 'DELETED', [])] }));
    expect(await createTiktokAdapter(config, fetchFn).countRemote!(token)).toEqual({ productCount: 10_000, skuCount: null });
  });

  it('sàn không trả `total_count` mà trang đầu đầy thì `unexpected_response`, không đoán số', async () => {
    await expect(createTiktokAdapter(config, fakeFetch(ok({ next_page_token: 'p2', products: fullPage() }))).countRemote!(token)).rejects.toMatchObject({
      kind: 'rejected',
      platformCode: 'unexpected_response',
    });
  });

  it('lời gọi `DELETED` có sản phẩm mà thiếu `total_count` thì `unexpected_response`', async () => {
    const fetchFn = fakeFetch(ok({ total_count: 305, products: fullPage() }), ok({ products: [product('900', 'DELETED', [])] }));
    await expect(createTiktokAdapter(config, fetchFn).countRemote!(token)).rejects.toMatchObject({ kind: 'rejected', platformCode: 'unexpected_response' });
  });

  it('lỗi của sàn đi qua cách đổi lỗi chung', async () => {
    const unauthorized = json({ code: 105002, message: 'Expired credentials', request_id: 'r' });
    await expect(createTiktokAdapter(config, fakeFetch(unauthorized)).countRemote!(token)).rejects.toMatchObject({ kind: 'unauthorized' });
    await expect(createTiktokAdapter(config, fakeFetch(json({}, 503))).countRemote!(token)).rejects.toMatchObject({ kind: 'unavailable' });
    // Lỗi ở lời gọi thứ hai cũng ném, không trả số sản phẩm còn tính cả đã xoá.
    const second = fakeFetch(ok({ total_count: 305, products: fullPage() }), json({ code: 105005, message: 'no scope', request_id: 'r' }));
    await expect(createTiktokAdapter(config, second).countRemote!(token)).rejects.toMatchObject({ kind: 'rejected', platformCode: '105005' });
  });
});
