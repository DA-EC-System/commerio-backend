// Category và attribute của sản phẩm trên sàn (#400 lát 12: ghép SKU dựng spec từ sàn), trên phản hồi gọi thật 18/11/2026
// (test/fixtures/channel): Lazada GetProductItem `/product/item/get` (`item_id`; `data.primary_category`, `data.attributes`
// tên → nhãn; open.lazada.com tra 19/11/2026, request_id 21412a8b17950174625785193); TikTok Get Product 202309
// (`category_chains`, `product_attributes` kèm mã giá trị, cả giá trị tự nhập; OAS cục bộ tts-openapi-guide).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createLazadaAdapter } from '#src/modules/channel/channel/service/marketplaces/lazada.ts';
import { createTiktokClient, packTiktokToken } from '#src/modules/channel/channel/service/marketplaces/tiktok-client.ts';
import { tiktokListingMethods } from '#src/modules/channel/channel/service/marketplaces/tiktok-listing.ts';

const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/channel', name), 'utf8')) as T;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('Lazada productCategory', () => {
  const config = { appKey: '143465', appSecret: 'secret', redirectUrl: undefined, apiUrl: 'https://api.test/rest', authUrl: 'https://auth.test' };

  it('gọi /product/item/get theo item_id; category là primary_category, attribute tên → nhãn (không mã)', async () => {
    const fn = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('lazada-item.json')));
    const got = await createLazadaAdapter(config, fn).productCategory!('tok', '3000123');
    const u = new URL(String(fn.mock.calls[0]![0]));
    expect(u.pathname).toBe('/rest/product/item/get');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ access_token: 'tok', item_id: '3000123' });
    expect(got!.externalCategoryId).toBe('10100278');
    expect(got!.attributes).toContainEqual({ code: 'material', values: [{ id: null, name: 'Stainless Steel' }] });
    expect(got!.attributes).toContainEqual({ code: 'brand', values: [{ id: null, name: 'No Brand' }] });
  });

  it('không có primary_category: null', async () => {
    const fn = vi.fn<typeof fetch>().mockResolvedValue(json({ code: '0', data: { attributes: {} } }));
    expect(await createLazadaAdapter(config, fn).productCategory!('tok', '1')).toBeNull();
  });
});

describe('TikTok productCategory', () => {
  const config = { appKey: 'appk', appSecret: 'apps', serviceId: undefined, apiUrl: 'https://open.test', authUrl: 'https://auth.test' };
  const TOKEN = packTiktokToken({ token: 'TTP_at', cipher: 'ROW_c', shopId: '749' });

  it('Get Product: leaf của category_chains, attribute theo mã kèm mã và tên giá trị', async () => {
    const paths: string[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      paths.push(new URL(String(input)).pathname);
      return json({ code: 0, message: 'Success', request_id: 'r', data: fixture('tiktok-product.json') });
    });
    const got = await tiktokListingMethods(createTiktokClient(config, fetchFn)).productCategory!(TOKEN, '1738417412913137169');
    expect(paths[0]).toBe('/product/202309/products/1738417412913137169');
    expect(got!.externalCategoryId).toBe('600042');
    expect(got!.attributes[0]).toEqual({ code: '100149', values: [{ id: '1000854', name: 'Việt Nam' }] });
    expect(got!.attributes).toHaveLength(3);
  });

  it('không có leaf: null', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => json({ code: 0, message: 'Success', request_id: 'r', data: { category_chains: [] } }));
    expect(await tiktokListingMethods(createTiktokClient(config, fetchFn)).productCategory!(TOKEN, '1')).toBeNull();
  });
});
