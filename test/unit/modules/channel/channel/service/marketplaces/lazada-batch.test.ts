// Kéo đơn Lazada theo lô (#267): thông tin đơn từ trang `/orders/get`, món bằng `/orders/items/get` tối đa 50 đơn mỗi lần
// (open.lazada.com GetMultipleOrderItems, tra 06/11/2026). Sàn giả bắt chước hai điều đo trên shop thử ngày 06/11/2026:
// `/orders/items/get` không trả `product_id`; `/orders/get` lọc `status` chỉ trả trạng thái được lọc trong `statuses`.
import { describe, expect, it } from 'vitest';
import type { RemoteOrderRef } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { createLazadaAdapter } from '#src/modules/channel/channel/service/marketplaces/lazada.ts';

const config = { appKey: 'k', appSecret: 's', redirectUrl: 'https://app/cb', apiUrl: 'https://api.test/rest', authUrl: 'https://auth.test' };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const base = Date.parse('2026-11-01T00:00:00Z');
const lazadaTime = (ms: number) => `${new Date(ms + 7 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')} +0700`;
type Row = Record<string, unknown>;

// Dạng đơn và món rút gọn từ payload thật (`lazada-order.test.ts`).
function shopData(n: number) {
  const orders = new Map<string, Row>();
  const items = new Map<string, Row[]>();
  for (let k = 0; k < n; k++) {
    const id = String(533732107780000 + k);
    const lineStatuses = k % 3 === 0 ? ['canceled', 'pending'] : ['pending'];
    orders.set(id, {
      order_id: Number(id),
      created_at: lazadaTime(base - k * 60_000),
      updated_at: lazadaTime(base + k * 1000),
      payment_method: k % 2 ? 'COD' : 'MIXEDCARD',
      statuses: lineStatuses,
      shipping_fee: 15000,
      is_cancel_pending: false,
      need_cancel_confirm: k % 5 === 0,
      address_shipping: { first_name: 'G***l', last_name: '', phone: '84********22', address1: '6**8', city: 'Phường Tân Sơn Hòa', country: 'Vietnam' },
      buyer_note: k % 4 === 0 ? 'Giao giờ hành chính' : '',
      shipping_fee_original: 20000,
      shipping_fee_discount_seller: 5000,
      shipping_fee_discount_platform: 0,
    });
    items.set(
      id,
      lineStatuses.map((status, j) => ({
        order_item_id: Number(id) * 10 + j,
        order_id: Number(id),
        sku: `SKU-${k % 7}`,
        name: 'Áo thun cổ tròn',
        status,
        item_price: 23456,
        paid_price: 20456,
        voucher_seller: 2000,
        voucher_platform: 1000,
        package_id: `FP${id}`,
        tracking_code: '',
        fulfillment_sla: 'Vui lòng đảm bảo đơn hàng sẽ được giao trước 2026-11-04 23:59:19 để tuân thủ',
        sku_id: `1175463880${k}`,
        shop_sku: `13502898${k}_VNAMZ-1175463880${k}`,
        product_id: `13502898${k}`,
        variation: 'Màu:Đỏ',
        shipment_provider: 'J&T VN',
        cancel_return_initiator: status === 'canceled' ? 'cancellation-customer' : 'null-null',
      })),
    );
  }
  return { orders, items };
}

function fakeLazada(data: ReturnType<typeof shopData>, opts: { dropFromBatch?: string } = {}) {
  const calls: string[] = [];
  const fn = async (url: string | URL | Request) => {
    const u = new URL(String(url));
    const q = u.searchParams;
    const path = u.pathname.replace(/^\/rest/, '');
    calls.push(path);
    switch (path) {
      case '/orders/get': {
        const status = q.get('status');
        const after = Date.parse(q.get('update_after')!);
        const all = [...data.orders.values()]
          .filter((o) => Date.parse(String(o.updated_at).replace(' ', 'T').replace(' +0700', '+07:00')) >= after)
          .filter((o) => !status || (o.statuses as string[]).includes(status));
        const offset = Number(q.get('offset'));
        const page = all.slice(offset, offset + Number(q.get('limit'))).map((o) => (status ? { ...o, statuses: [status] } : o));
        return json({ code: '0', data: { countTotal: all.length, orders: page } });
      }
      case '/order/get':
        return json({ code: '0', data: data.orders.get(q.get('order_id')!) });
      case '/order/items/get':
        return json({ code: '0', data: data.items.get(q.get('order_id')!) });
      case '/orders/items/get': {
        const ids = (JSON.parse(q.get('order_ids')!) as number[]).map(String);
        if (ids.length > 50) return json({ code: '38', type: 'ISV', message: 'E038: Too many orders were requested' });
        return json({
          code: '0',
          data: ids
            .filter((id) => id !== opts.dropFromBatch)
            .map((id) => ({
              order_id: id,
              order_number: id,
              order_items: data.items.get(id)!.map(({ product_id: _p, ...i }) => i),
            })),
        });
      }
      default:
        return json({ code: 'InvalidApiPath', type: 'ISV', message: path });
    }
  };
  return { fn, calls };
}

async function listAll(adapter: ReturnType<typeof createLazadaAdapter>, open: boolean) {
  const refs: RemoteOrderRef[] = [];
  let cursor: string | null = null;
  do {
    const page: { orders: RemoteOrderRef[]; nextCursor: string | null } = open ? await adapter.listOpenOrders!('t', cursor) : await adapter.listOrders!('t', new Date(base - 60_000), cursor);
    refs.push(...page.orders);
    cursor = page.nextCursor;
  } while (cursor);
  return refs;
}

const count = (calls: string[], path: string) => calls.filter((c) => c === path).length;

describe('Lazada: getOrders theo lô (#267)', () => {
  it('kéo 120 đơn: gọi sàn = số trang + ceil(120/50); RemoteOrder giống hệt getOrder từng đơn', async () => {
    const data = shopData(120);
    const batch = fakeLazada(data);
    const adapter = createLazadaAdapter(config, batch.fn);
    const refs = await listAll(adapter, false);
    expect(refs).toHaveLength(120);
    const many = await adapter.getOrders!('t', refs);
    expect(count(batch.calls, '/orders/get')).toBe(2);
    expect(count(batch.calls, '/orders/items/get')).toBe(3);
    expect(batch.calls).toHaveLength(2 + 3);

    const single = fakeLazada(data);
    const one = createLazadaAdapter(config, single.fn);
    const expected = [];
    for (const r of refs) expected.push(await one.getOrder!('t', r.externalOrderId));
    expect(single.calls).toHaveLength(240);
    expect(many).toEqual(expected);
  });

  it('lượt đơn còn mở (lọc `status`): trạng thái đơn lấy theo món, không theo `statuses` đã bị lọc', async () => {
    const data = shopData(9);
    const adapter = createLazadaAdapter(config, fakeLazada(data).fn);
    const refs = await listAll(adapter, true);
    const first = new Map<string, RemoteOrderRef>();
    for (const r of refs) if (!first.has(r.externalOrderId)) first.set(r.externalOrderId, r);
    const many = await adapter.getOrders!('t', [...first.values()]);
    const one = createLazadaAdapter(config, fakeLazada(data).fn);
    for (const o of many) expect(o).toEqual(await one.getOrder!('t', o.externalOrderId));
    expect(many.find((o) => o.externalOrderId === '533732107780000')?.rawStatus).toBe('canceled,pending');
  });

  it('ref không có `detail` thì gọi `/order/get` cho đơn đó; đơn sàn không trả món trong lô thì gọi `/order/items/get` riêng', async () => {
    const data = shopData(3);
    const ids = [...data.orders.keys()];
    const fake = fakeLazada(data, { dropFromBatch: ids[2] });
    const adapter = createLazadaAdapter(config, fake.fn);
    const [withDetail] = await listAll(adapter, false);
    fake.calls.length = 0;
    const refs: RemoteOrderRef[] = [withDetail!, ...ids.slice(1).map((id) => ({ externalOrderId: id, placedAt: new Date(base), updatedAt: new Date(base) }))];
    const many = await adapter.getOrders!('t', refs);
    expect(fake.calls).toEqual(['/order/get', '/order/get', '/orders/items/get', '/order/items/get']);
    expect(many.map((o) => o.externalOrderId)).toEqual(ids);
    expect(many[2]!.lines).toHaveLength(data.items.get(ids[2]!)!.length);
  });

  it('món không có `product_id` (như `/orders/items/get`): mã sản phẩm lấy từ phần đầu `shop_sku`; `shop_sku` lạ thì null', async () => {
    const data = shopData(2);
    const ids = [...data.orders.keys()];
    data.items.get(ids[1]!)![0]!.shop_sku = 'KHONG-CO-GACH';
    const adapter = createLazadaAdapter(config, fakeLazada(data).fn);
    const many = await adapter.getOrders!('t', await listAll(adapter, false));
    expect(many[0]!.lines[0]!.info.externalProductId).toBe('135028980');
    expect(many[1]!.lines[0]!.info.externalProductId).toBeNull();
  });
});
