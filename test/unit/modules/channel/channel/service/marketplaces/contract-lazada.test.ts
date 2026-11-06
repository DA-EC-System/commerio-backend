// Adapter Lazada qua bộ ca hợp đồng (#200), với sàn giả theo đường dẫn API Lazada. Dạng phản hồi rút gọn từ payload thật
// ở `lazada.test.ts`, `lazada-order.test.ts`, `lazada-paging.test.ts`.
import { createLazadaAdapter } from '#src/modules/channel/channel/service/marketplaces/lazada.ts';
import { describeAdapterContract } from './adapter-contract.ts';

const config = {
  appKey: 'k',
  appSecret: 's',
  redirectUrl: 'https://app.test/cb',
  apiUrl: 'https://api.test/rest',
  authUrl: 'https://auth.test',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const lazadaTime = (ms: number) => `${new Date(ms + 7 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')} +0700`;
const BAD = { code: 'IllegalAccessToken', type: 'ISV', message: 'Invalid access token' };

function fakeLazada(state: { orders?: Map<string, number> } = {}) {
  return async (url: string | URL | Request): Promise<Response> => {
    const u = new URL(String(url));
    const q = u.searchParams;
    switch (u.pathname.replace(/^\/rest/, '')) {
      case '/auth/token/create':
      case '/auth/token/refresh':
        return json({ code: '0', access_token: 'at', refresh_token: 'rt', expires_in: 864000, refresh_expires_in: 4320000 });
      case '/seller/get':
        return q.get('access_token') === 'at' ? json({ code: '0', data: { seller_id: 200185074242, name: 'Shop thử' } }) : json(BAD);
      case '/products/get':
        return json({
          code: '0',
          data: {
            products: [
              { item_id: 1, status: 'Active', attributes: { name: 'Áo' }, skus: [{ SkuId: 11, SellerSku: 'AO-M', quantity: 3 }] },
              { item_id: 2, status: 'Pending QC', attributes: { name: 'Quần' }, skus: [{ SkuId: 21, SellerSku: 'QUAN-L', quantity: 0 }] },
              { item_id: 3, status: 'Active', attributes: { name: 'Của shop khác' }, skus: [{ SkuId: 31, SellerSku: 'KHAC', quantity: 9 }] },
            ],
          },
        });
      case '/orders/get': {
        const after = Date.parse(q.get('update_after')!);
        const offset = Number(q.get('offset'));
        const limit = Number(q.get('limit'));
        const all = [...(state.orders ?? new Map())].filter(([, t]) => t >= after).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
        const orders = all
          .slice(offset, offset + limit)
          .map(([id, t]) => ({ order_id: id, created_at: lazadaTime(t), updated_at: lazadaTime(t) }));
        return json({ code: '0', data: { countTotal: all.length, orders } });
      }
      case '/order/get':
        return json({
          code: '0',
          data: {
            order_id: q.get('order_id'),
            created_at: '2026-10-29 14:41:18 +0700',
            updated_at: '2026-10-29 14:41:34 +0700',
            price: '23456.00',
            payment_method: 'COD',
            statuses: ['packed'],
            shipping_fee: 0,
            address_shipping: null,
          },
        });
      case '/order/items/get':
        return json({
          code: '0',
          data: ['packed', 'delivered', 'trạng-thái-lạ'].map((status, i) => ({
            order_item_id: 100 + i,
            order_id: q.get('order_id'),
            sku: 'AO-M',
            name: 'Áo',
            status,
            item_price: 23456,
            paid_price: 23456,
            voucher_seller: 0,
            voucher_platform: 0,
            package_id: 'FP1',
            tracking_code: '',
            fulfillment_sla: '',
          })),
        });
      default:
        return json({ code: 'InvalidApiPath', type: 'ISV', message: u.pathname });
    }
  };
}

describeAdapterContract('Lazada', {
  connected: (state) => createLazadaAdapter(config, fakeLazada(state)),
  unconfigured: () => {
    let calls = 0;
    const adapter = createLazadaAdapter({ ...config, appKey: undefined, appSecret: undefined, redirectUrl: undefined }, async (url) => {
      calls += 1;
      return fakeLazada()(url);
    });
    return { adapter, calls: () => calls };
  },
  failing: (mode) =>
    createLazadaAdapter(config, async () => {
      if (mode === 'network') throw new Error('ECONNRESET');
      return mode === 'http_5xx' ? json({}, 502) : json(BAD);
    }),
  callbackParams: { code: 'c1', app_key: 'k' },
  accessToken: 'at',
  sellerSkus: ['AO-M', 'QUAN-L'],
  orderId: '533732107780318',
});
