// Gợi ý category của sàn theo sản phẩm (#400 lát 9, AC-1, AC-2) trên phản hồi gọi thật 18/11/2026 (test/fixtures/channel):
// Lazada GetCategorySuggestion `/product/category/suggestion/get` (`product_name`, `image_url`, cần access_token; mã 701 là
// không đoán được; open.lazada.com tra 19/11/2026); TikTok Recommend Category 202309 (`product_title`, `category_version`,
// OAS cục bộ tts-openapi-guide; tên dưới 25 ký tự sàn từ chối).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createLazadaAdapter } from '#src/modules/channel/channel/service/marketplaces/lazada.ts';
import { createTiktokClient, packTiktokToken } from '#src/modules/channel/channel/service/marketplaces/tiktok-client.ts';
import { tiktokListingMethods } from '#src/modules/channel/channel/service/marketplaces/tiktok-listing.ts';
import { createTiktokAdapter } from '#src/modules/channel/channel/service/marketplaces/tiktok.ts';

const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/channel', name), 'utf8')) as T;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('Lazada suggestCategories', () => {
  const config = { appKey: '143465', appSecret: 'secret', redirectUrl: undefined, apiUrl: 'https://api.test/rest', authUrl: 'https://auth.test' };
  const lazada = (body: unknown) => {
    const fn = vi.fn<typeof fetch>().mockResolvedValue(json(body));
    return { fn, adapter: createLazadaAdapter(config, fn) };
  };

  it('bắt buộc ảnh, không giới hạn độ dài tên', () => {
    expect(createLazadaAdapter(config, vi.fn()).suggestionRules).toEqual({ needsImage: true });
    expect(createLazadaAdapter(config, vi.fn()).categoryPermissionsPerShop).toBeUndefined();
  });

  it('gửi tên, ảnh, token; tối đa 5 đúng thứ tự sàn, đường dẫn sàn nối " > ", không có quyền', async () => {
    const { fn, adapter } = lazada(fixture('lazada-suggestion.json'));
    const items = await adapter.suggestCategories!('tok', { name: 'Áo thun nam cổ tròn', imageUrl: 'https://img.test/a.jpg' });
    const u = new URL(String(fn.mock.calls[0]![0]));
    expect(u.pathname).toBe('/rest/product/category/suggestion/get');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      access_token: 'tok',
      product_name: 'Áo thun nam cổ tròn',
      image_url: 'https://img.test/a.jpg',
    });
    expect(items.map((i) => i.externalId)).toEqual(['7930', '7545', '7932', '4184', '14275']);
    expect(items[0]).toEqual({ externalId: '7930', path: "Men's Clothing > Tops > T-Shirts & Tanks", permissionStatuses: null });
  });

  it('mã 701 (không đoán được): danh sách rỗng, không ném', async () => {
    const { adapter } = lazada({ code: '701', message: 'E701: Empty category suggestion.', request_id: 'r' });
    await expect(adapter.suggestCategories!('tok', { name: 'xyz', imageUrl: 'https://img.test/a.jpg' })).resolves.toEqual([]);
  });

  it('lỗi khác vẫn ném', async () => {
    const { adapter } = lazada({ code: 'MissingParameter', message: 'x', request_id: 'r' });
    await expect(adapter.suggestCategories!('tok', { name: 'xyz', imageUrl: 'https://img.test/a.jpg' })).rejects.toMatchObject({ kind: 'rejected' });
  });
});

describe('TikTok suggestCategories', () => {
  const config = { appKey: 'appk', appSecret: 'apps', serviceId: undefined, apiUrl: 'https://open.test', authUrl: 'https://auth.test' };
  const TOKEN = packTiktokToken({ token: 'TTP_at', cipher: 'ROW_c', shopId: '749' });

  it('tên tối thiểu 25 ký tự, không cần ảnh', () => {
    expect(createTiktokAdapter(config, vi.fn()).suggestionRules).toEqual({ minNameLength: 25 });
    // Quyền category theo gian hàng (A17): việc đẩy đọc cây bằng token gian hàng; Lazada không có.
    expect(createTiktokAdapter(config, vi.fn()).categoryPermissionsPerShop).toBe(true);
  });

  it('POST recommend với tên và cây v2; một leaf, đường dẫn nối tên các cấp, quyền của leaf', async () => {
    const calls: { path: string; method: string; body: unknown }[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      calls.push({ path: new URL(String(input)).pathname, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
      return json({ code: 0, message: 'Success', request_id: 'r', data: fixture('tiktok-suggestion.json') });
    });
    const methods = tiktokListingMethods(createTiktokClient(config, fetchFn));
    const items = await methods.suggestCategories!(TOKEN, { name: 'Giày sneaker nam vải canvas đế cao su Classic', imageUrl: null });
    expect(calls[0]).toMatchObject({
      path: '/product/202309/categories/recommend',
      method: 'POST',
      body: { product_title: 'Giày sneaker nam vải canvas đế cao su Classic', category_version: 'v2' },
    });
    expect(items).toEqual([
      { externalId: '601357', path: 'Giày dép > Giày dép nam > Giày thể thao thường ngày', permissionStatuses: ['AVAILABLE'] },
    ]);
  });

  it('không có leaf_category_id: rỗng', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => json({ code: 0, message: 'Success', request_id: 'r', data: { categories: [] } }));
    const methods = tiktokListingMethods(createTiktokClient(config, fetchFn));
    await expect(methods.suggestCategories!(TOKEN, { name: 'x'.repeat(30), imageUrl: null })).resolves.toEqual([]);
  });
});
