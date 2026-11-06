// Adapter TikTok qua bộ ca hợp đồng (#200, #217), với sàn giả theo đường dẫn API TikTok. Dạng phản hồi theo docv2
// (authorization-overview-202407, get-authorized-shops-202309, search-products-202502, get-order-list-202309,
// get-order-detail-202507) và kết quả gọi thật ở #217, #221.
import { createTiktokAdapter } from '#src/modules/channel/channel/service/marketplaces/tiktok.ts';
import { packTiktokToken } from '#src/modules/channel/channel/service/marketplaces/tiktok-client.ts';
import { describeAdapterContract } from './adapter-contract.ts';

const config = { appKey: 'k', appSecret: 's', serviceId: 'svc', apiUrl: 'https://open.test', authUrl: 'https://auth.test' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ok = (data: unknown) => json({ code: 0, message: 'Success', data });
const BAD = { code: 105002, message: 'Expired credentials. The x-tts-access-token header has expired.' };
const SHOP_ID = '7495013067939481105';
const PACKED = packTiktokToken({ token: 'TTP_at', cipher: 'ROW_c', shopId: SHOP_ID });

/** `state.orders`: mã đơn → `updatedAt` (ms) như bộ ca; sàn giả lật `page_token` theo offset (trường hợp xấu nhất). */
function fakeTiktok(state: { orders?: Map<string, number> } = {}) {
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const token = (init?.headers as Record<string, string> | undefined)?.['x-tts-access-token'];
    switch (u.pathname) {
      case '/api/v2/token/get':
      case '/api/v2/token/refresh':
        return ok({ access_token: 'TTP_at', access_token_expire_in: 1794588545, refresh_token: 'TTP_rt', refresh_token_expire_in: 4915695420 });
      case '/authorization/202309/shops':
        // Bộ ca truyền cùng `accessToken` cho `connectWithToken` (token thô dán từ Partner Center) và các hàm gọi sàn (token
        // đã gói): sàn giả nhận cả hai ở đây; đường token thô thật kiểm ở `tiktok.test.ts`.
        return token === 'TTP_at' || token === PACKED ? ok({ shops: [{ id: SHOP_ID, name: 'Shop thử', region: 'VN', cipher: 'ROW_c', seller_type: 'LOCAL' }] }) : json(BAD);
      case '/product/202502/products/search':
        if (token !== 'TTP_at' || u.searchParams.get('shop_cipher') !== 'ROW_c') return json(BAD);
        return ok({
          total_count: 3,
          products: [
            { id: '1', title: 'Áo', status: 'ACTIVATE', skus: [{ id: '11', seller_sku: 'AO-M', inventory: [{ quantity: 3 }] }] },
            { id: '2', title: 'Quần', status: 'PENDING', skus: [{ id: '21', seller_sku: 'QUAN-L', inventory: [{ quantity: 0 }] }] },
            { id: '3', title: 'Khác', status: 'ACTIVATE', skus: [{ id: '31', seller_sku: 'KHAC', inventory: [{ quantity: 9 }] }] },
          ],
        });
      case '/order/202309/orders/search': {
        if (token !== 'TTP_at') return json(BAD);
        const f = JSON.parse(String(init?.body ?? '{}')) as { update_time_ge?: number; update_time_lt?: number };
        const all = [...(state.orders ?? new Map<string, number>())]
          .map(([id, ms]) => ({ id, t: Math.floor(ms / 1000) }))
          .filter((o) => o.t >= (f.update_time_ge ?? -Infinity) && o.t < (f.update_time_lt ?? Infinity))
          .sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
        const offset = Number(u.searchParams.get('page_token') || 0);
        const size = Number(u.searchParams.get('page_size'));
        return ok({
          total_count: all.length,
          next_page_token: offset + size < all.length ? String(offset + size) : '',
          orders: all.slice(offset, offset + size).map((o) => ({ id: o.id, create_time: o.t - 60, update_time: o.t, status: 'AWAITING_SHIPMENT', line_items: [] })),
        });
      }
      case '/order/202507/orders':
        if (token !== 'TTP_at') return json(BAD);
        return ok({
          orders: (u.searchParams.get('ids') ?? '').split(',').map((id) => ({
            id,
            status: 'AWAITING_SHIPMENT',
            create_time: 1793971210,
            update_time: 1793971311,
            payment: { shipping_fee: '300' },
            line_items: [
              { id: `${id}-1`, display_status: 'AWAITING_SHIPMENT', package_status: 'TO_FULFILL', package_id: 'P1', seller_sku: 'AO-M', original_price: '61000' },
              { id: `${id}-2`, display_status: 'AWAITING_SHIPMENT', package_status: 'PROCESSING', package_id: 'P2', seller_sku: 'QUAN-L', original_price: '250000' },
            ],
          })),
        });
      default:
        return json({ code: 36009009, message: 'Invalid path' });
    }
  };
}

describeAdapterContract('TikTok Shop', {
  connected: (state) => createTiktokAdapter(config, fakeTiktok(state)),
  unconfigured: () => {
    let calls = 0;
    const adapter = createTiktokAdapter({ ...config, appKey: undefined, appSecret: undefined, serviceId: undefined }, async (url, init) => {
      calls += 1;
      return fakeTiktok()(url, init);
    });
    return { adapter, calls: () => calls };
  },
  failing: (mode) =>
    createTiktokAdapter(config, async () => {
      if (mode === 'network') throw new Error('ECONNRESET');
      return mode === 'http_5xx' ? json({}, 502) : json(BAD);
    }),
  callbackParams: { code: 'c1', app_key: 'k', locale: 'vi-VN', shop_region: 'VN' },
  accessToken: PACKED,
  sellerSkus: ['AO-M', 'QUAN-L'],
  orderId: '586945714962334730',
});
