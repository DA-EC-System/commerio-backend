// Giá gốc SKU đọc từ sàn để phát hiện người bán sửa giá ngoài app (#360, Documents/21 §18.3): không lấy giá khuyến mãi.
import { describe, expect, it, vi } from 'vitest';
import { createLazadaAdapter } from '#src/modules/channel/channel/service/marketplaces/lazada.ts';
import { packTiktokToken } from '#src/modules/channel/channel/service/marketplaces/tiktok-client.ts';
import { createTiktokAdapter } from '#src/modules/channel/channel/service/marketplaces/tiktok.ts';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
function fakeFetch(...bodies: unknown[]) {
  const fn = vi.fn<typeof fetch>();
  for (const b of bodies) fn.mockResolvedValueOnce(json(b));
  return fn;
}

describe('Lazada: giá gốc của SKU', () => {
  const config = { appKey: 'k', appSecret: 's', redirectUrl: undefined, apiUrl: 'https://api.test/rest', authUrl: 'https://auth.test' };
  const product = (sku: object) => ({ code: '0', data: { products: [{ item_id: 1, status: 'Active', skus: [{ SkuId: 1, SellerSku: 'A', quantity: 3, ...sku }] }] } });

  it('lấy `price`, không lấy `special_price` (giá khuyến mãi)', async () => {
    const [sku] = await createLazadaAdapter(config, fakeFetch(product({ price: 95000, special_price: 80000 }))).getSkus('t', ['A']);
    expect(sku!.price).toBe('95000');
  });

  it('sàn không trả giá thì không có `price` (không so)', async () => {
    const [sku] = await createLazadaAdapter(config, fakeFetch(product({}))).getSkus('t', ['A']);
    expect(sku!.price).toBeUndefined();
  });
});

describe('TikTok: giá gốc của SKU', () => {
  const config = { appKey: 'appk', appSecret: 'apps', serviceId: '1', apiUrl: 'https://open.test', authUrl: 'https://auth.test' };
  const token = packTiktokToken({ token: 'TTP_at', cipher: 'ROW_cipher', shopId: '7' });
  const ok = (data: unknown) => ({ code: 0, message: 'Success', request_id: 'r', data });
  const search = (price?: object) =>
    ok({ total_count: 1, next_page_token: '', products: [{ id: '1', title: 'SP', status: 'ACTIVATE', skus: [{ id: '11', seller_sku: 'A', inventory: [{ quantity: 2 }], ...(price && { price }) }] }] });

  it('lấy `price.tax_exclusive_price` (giá hiển thị trước giảm giá của người bán nội địa)', async () => {
    const fn = fakeFetch(search({ currency: 'VND', tax_exclusive_price: '120000', sale_price: '120000' }), ok({ id: '1', main_images: [], skus: [{ id: '11' }] }));
    const [sku] = await createTiktokAdapter(config, fn).listSkus!(token);
    expect(sku!.price).toBe('120000');
  });

  it('không có `price` thì không so', async () => {
    const fn = fakeFetch(search(), ok({ id: '1', main_images: [], skus: [{ id: '11' }] }));
    const [sku] = await createTiktokAdapter(config, fn).listSkus!(token);
    expect(sku!.price).toBeUndefined();
  });
});
