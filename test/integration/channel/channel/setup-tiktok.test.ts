// Bước ghép khi thiết lập gian hàng TikTok (#282): adapter TikTok thật, sàn giả nói đúng wire format Search Products 202502
// (lật `page_token`), qua route `GET /channel/shops/:id/setup`. Ghép theo `seller_sku` dùng chung luật với Lazada (#198).
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ShopSetupPreview } from '#src/modules/channel/channel/api/schemas.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { createTiktokAdapter } from '#src/modules/channel/channel/service/marketplaces/tiktok.ts';
import { type ListingVariant, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { logger } from '#src/shared/logger.ts';
import { createCompany } from '../../helpers/company.ts';
import { testApp } from '../../helpers/http.ts';

const config = { appKey: 'tk', appSecret: 'ts', serviceId: undefined, apiUrl: 'https://open.tiktok.test', authUrl: 'https://auth.tiktok.test' };
const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, message: 'Success', request_id: 'r', data }), { status: 200 });

const shopId = String(7_100_000_000_000_000_000n + BigInt(Math.floor(Math.random() * 1e12)));
const cipher = `ROW_${randomUUID().replace(/-/g, '')}`;
const ACCESS = `TTP_${randomUUID().replace(/-/g, '')}`;

const tkSku = (id: string, sellerSku: string | undefined, quantity: number) => ({
  id,
  ...(sellerSku === undefined ? {} : { seller_sku: sellerSku }),
  inventory: [{ quantity, warehouse_id: 'w1' }],
  status_info: { status: 'NORMAL' },
});
// Hai trang như shop thử VN (gọi thật 09/11/2026): cốc hai SKU cùng tiêu đề, sản phẩm thiếu SKU người bán, sản phẩm đã xoá.
const pages: Record<string, unknown> = {
  '': {
    total_count: 4,
    next_page_token: 'p2',
    products: [
      { id: '1738338487553328657', title: 'Cốc sứ có quai 350ml', status: 'ACTIVATE', skus: [tkSku('1738338453674427921', 'CM-TEST-MUG-TRANG', 14), tkSku('1738338453674493457', 'CM-TEST-MUG-DEN', 0)] },
      { id: '1738350612753122833', title: 'Sandbox Default Test Product 1G', status: 'ACTIVATE', skus: [tkSku('1738350612634830353', undefined, 198)] },
    ],
  },
  p2: {
    total_count: 5,
    next_page_token: '',
    products: [
      { id: '1738417412913137169', title: 'Sản phẩm thử API Commerio', status: 'PENDING', skus: [tkSku('1738417427328763409', 'CM-TEST-202611061719', 5)] },
      { id: '1738417412913137170', title: 'Sản phẩm đã xoá', status: 'DELETED', skus: [tkSku('1738417427328763410', 'CM-DEL', 1)] },
      // Trùng SKU người bán với cốc trắng: biến thể chỉ được gợi ý cho một dòng.
      { id: '1738417412913137171', title: 'Cốc trắng bản cũ', status: 'ACTIVATE', skus: [tkSku('1738417427328763411', 'CM-TEST-MUG-TRANG', 2)] },
    ],
  },
};
const fetchFn = vi.fn<typeof fetch>(async (url) => {
  const u = new URL(String(url));
  if (u.pathname === '/authorization/202309/shops') return ok({ shops: [{ id: shopId, name: 'Commerio_Testing_Acc', region: 'VN', cipher, seller_type: 'LOCAL' }] });
  if (u.pathname === '/product/202502/products/search') return ok(pages[u.searchParams.get('page_token') ?? '']);
  // Get Product 202309: chỉ sản phẩm nhiều SKU (cốc) được đọc nhãn biến thể.
  if (u.pathname === '/product/202309/products/1738338487553328657') {
    return ok({
      id: '1738338487553328657',
      skus: [
        { id: '1738338453674427921', sales_attributes: [{ id: '100000', name: 'Màu', value_id: '1', value_name: 'Trắng' }] },
        { id: '1738338453674493457', sales_attributes: [{ id: '100000', name: 'Màu', value_id: '2', value_name: 'Đen' }] },
      ],
    });
  }
  return ok({});
});

const mugWhite: ListingVariant = {
  id: randomUUID(),
  productId: randomUUID(),
  productName: 'Cốc sứ Commerio',
  sku: 'CM-TEST-MUG-TRANG',
  categoryId: randomUUID(),
  attributesLabel: 'Trắng',
  archived: false,
  description: null,
  weightG: 300,
  lengthMm: 100,
  widthMm: 100,
  heightMm: 100,
};

// Biến thể cùng tên với SKU đen trên sàn: ghép theo tên được nhờ tiêu đề có nhãn biến thể.
const mugBlack: ListingVariant = { ...mugWhite, id: randomUUID(), productId: randomUUID(), productName: 'Cốc sứ có quai 350ml', sku: 'CM-COC-DEN', attributesLabel: 'Đen' };

let company: Awaited<ReturnType<typeof createCompany>>;
beforeAll(async () => {
  registerAdapter('tiktok', createTiktokAdapter(config, fetchFn));
  setProductPort({
    variants: async (ids) => [mugWhite, mugBlack].filter((v) => !ids || ids.includes(v.id)),
    standardPrices: async (ids) => new Map(ids.map((id) => [id, new Decimal(50000)])),
    availableOf: async (ids) => new Map(ids.map((id) => [id, 9])),
  });
  company = await createCompany({ optionalModules: ['channel'] });
});
afterAll(() => {
  resetAdapters();
  setProductPort(null);
});

const detailCalls = () => fetchFn.mock.calls.map(([u]) => new URL(String(u)).pathname).filter((p) => p.startsWith('/product/202309/products/'));
const auth = (r: request.Test) => r.set('Authorization', `Bearer ${company.ceo.token}`);
let appShopId = '';

describe('thiết lập gian hàng TikTok: SKU có sẵn trên shop (#282)', () => {
  it('AC-1..AC-4: đọc hết các trang, mỗi SKU một dòng đúng mã SKU TikTok, tiêu đề kèm nhãn biến thể, ghép theo seller_sku; token, cipher không lộ', async () => {
    fetchFn.mockClear();
    const connected = await auth(request(testApp()).post('/api/v1/channel/shops/tiktok/token')).send({ accessToken: ACCESS });
    expect(connected.status).toBe(201);
    const shop = connected.body.shop as { id: string; status: string };
    appShopId = shop.id;
    expect(shop.status).toBe('connecting');
    // `remoteSkuCount` cùng nguồn `listSkus` nhưng không đọc nhãn biến thể (review chéo S-3).
    expect(connected.body.shops[0].remoteSkuCount).toBe(5);
    expect(detailCalls()).toEqual([]);

    const logged: unknown[] = [];
    const spies = (['debug', 'info', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => void logged.push(args)) as never),
    );
    fetchFn.mockClear();
    const res = await auth(request(testApp()).get(`/api/v1/channel/shops/${shop.id}/setup`));
    spies.forEach((s) => s.mockRestore());

    expect(res.status).toBe(200);
    const body = ShopSetupPreview.parse(res.body);
    // AC-3: hai trang, trang sau gửi `page_token` của trang trước.
    const searches = fetchFn.mock.calls.map(([u]) => new URL(String(u))).filter((u) => u.pathname === '/product/202502/products/search');
    expect(searches.map((u) => u.searchParams.get('page_token'))).toEqual([null, 'p2']);
    expect(searches.every((u) => u.searchParams.get('shop_cipher') === cipher)).toBe(true);
    // Nhãn biến thể: một lần Get Product cho sản phẩm nhiều SKU, không gọi cho sản phẩm một SKU.
    const details = fetchFn.mock.calls.map(([u]) => new URL(String(u)).pathname).filter((p) => p.startsWith('/product/202309/products/'));
    expect(details).toEqual(['/product/202309/products/1738338487553328657']);
    // AC-1: mọi SKU còn trên shop (bỏ sản phẩm đã xoá), `externalSkuId` là `skus[].id`; SKU của sản phẩm nhiều SKU có tiêu đề riêng.
    expect(body.suggestions.map((s) => [s.externalSkuId, s.title, s.platformStock])).toEqual([
      ['1738338453674427921', 'Cốc sứ có quai 350ml - Trắng', 14],
      ['1738338453674493457', 'Cốc sứ có quai 350ml - Đen', 0],
      ['1738350612634830353', 'Sandbox Default Test Product 1G', 198],
      ['1738417427328763409', 'Sản phẩm thử API Commerio', 5],
      ['1738417427328763411', 'Cốc trắng bản cũ', 2],
    ]);
    // AC-2: `seller_sku` trùng SKU Commerio thì gợi ý đúng biến thể; tiêu đề có nhãn thì ghép theo tên được.
    expect(body.suggestions[0]).toMatchObject({ match: 'sku', variantId: mugWhite.id, sku: 'CM-TEST-MUG-TRANG', available: 9, score: null });
    expect(body.suggestions[1]).toMatchObject({ match: 'name', variantId: mugBlack.id });
    // Mỗi biến thể gợi ý cho tối đa một dòng (gửi lại nguyên gợi ý không bị 422 `decisions.<i>`).
    expect(body.suggestions.slice(2).map((s) => [s.match, s.variantId])).toEqual([['none', null], ['none', null], ['none', null]]);
    expect(body.unmatchedRemote).toBe(3);
    // AC-4: token thô, token đã gói, cipher không có trong response hay log.
    const leak = new RegExp(`${ACCESS}|${cipher}|tts1\\.`);
    expect(JSON.stringify(res.body)).not.toMatch(leak);
    expect(inspect(logged, { depth: 6 })).not.toMatch(leak);
  });

  it('hoàn tất thiết lập: `decisions` không đọc nhãn biến thể; `externalSkuIds` cũ vẫn đọc (review chéo I-2)', async () => {
    const finish = (body: object) =>
      auth(request(testApp()).post(`/api/v1/channel/shops/${appShopId}/setup`)).send({ openingStock: 'stocktake', ...body });
    fetchFn.mockClear();
    await finish({ decisions: [{ externalSkuId: '1738338453674427921', variantId: mugWhite.id }] });
    expect(fetchFn.mock.calls.some(([u]) => new URL(String(u)).pathname === '/product/202502/products/search')).toBe(true);
    expect(detailCalls()).toEqual([]);
    fetchFn.mockClear();
    await finish({ externalSkuIds: ['1738338453674427921'] });
    expect(detailCalls()).toEqual(['/product/202309/products/1738338487553328657']);
  });
});
