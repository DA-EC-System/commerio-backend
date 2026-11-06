// Đơn và kiện TikTok (#221). Fixture dựng theo schema docv2 (get-order-list-202309, get-order-detail-202507,
// get-order-split-attributes-202309, confirm-order-split-202309, ship-package-202309; tra 07/11/2026) và theo phản hồi
// gọi thật trên shop thử sandbox ngày 07/11/2026 (đơn 586945714962334730, 587022741397144586; tên, SĐT, địa chỉ sàn đã che).
import { describe, expect, it, vi } from 'vitest';
import { MarketplaceError, type RemoteOrderRef } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { createTiktokClient, packTiktokToken } from '#src/modules/channel/channel/service/marketplaces/tiktok-client.ts';
import {
  TIKTOK_OPEN_STATUSES,
  tiktokLineStatus,
  tiktokOrderMethods,
  toTiktokOrder,
} from '#src/modules/channel/channel/service/marketplaces/tiktok-orders.ts';
import { createTiktokAdapter } from '#src/modules/channel/channel/service/marketplaces/tiktok.ts';

const config = { appKey: 'k', appSecret: 's', serviceId: undefined, apiUrl: 'https://open.test', authUrl: 'https://auth.test' };
const TOKEN = packTiktokToken({ token: 'TTP_at', cipher: 'ROW_c', shopId: '7495013067939481105' });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const ok = (data: unknown) => json({ code: 0, message: 'Success', request_id: 'r', data });

type Call = { method: string; path: string; query: URLSearchParams; body: Record<string, unknown> | null };

/** Sàn giả: ghi lại lời gọi, trả theo `handler`. */
function fakeSan(handler: (c: Call) => Response) {
  const calls: Call[] = [];
  const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
    const u = new URL(String(url));
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const call = { method: init?.method ?? 'GET', path: u.pathname, query: u.searchParams, body };
    calls.push(call);
    return handler(call);
  });
  return { calls, methods: tiktokOrderMethods(createTiktokClient(config, fetchFn)) };
}

/** Đơn trên sàn giả cho Get Order List: `update` giây, lật bằng `page_token` là offset (trường hợp xấu nhất). */
type FakeOrder = { update: number; create?: number; status?: string };
function searchHandler(orders: Map<string, FakeOrder>, pageSize = 100) {
  return (c: Call): Response => {
    if (c.path !== '/order/202309/orders/search') return json({ code: 36009009, message: 'Invalid path' });
    const f = c.body ?? {};
    const ge = typeof f.update_time_ge === 'number' ? f.update_time_ge : -Infinity;
    const lt = typeof f.update_time_lt === 'number' ? f.update_time_lt : Infinity;
    const all = [...orders]
      .filter(([, o]) => o.update >= ge && o.update < lt && (!f.order_status || (o.status ?? 'AWAITING_SHIPMENT') === f.order_status))
      .sort((a, b) => a[1].update - b[1].update || a[0].localeCompare(b[0]));
    const offset = Number(c.query.get('page_token') || 0);
    const size = Math.min(pageSize, Number(c.query.get('page_size')));
    const page = all.slice(offset, offset + size);
    return ok({
      total_count: all.length,
      next_page_token: offset + size < all.length ? String(offset + size) : '',
      orders: page.map(([id, o]) => ({ id, create_time: o.create ?? o.update - 60, update_time: o.update, status: o.status ?? 'AWAITING_SHIPMENT', line_items: [] })),
    });
  };
}

async function drain(list: (cursor: string | null) => Promise<{ orders: RemoteOrderRef[]; nextCursor: string | null; safeUntil: Date | null }>, onPage?: (n: number) => void) {
  const out: RemoteOrderRef[] = [];
  const safe: Date[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const p = await list(cursor);
    out.push(...p.orders);
    if (p.safeUntil) safe.push(p.safeUntil);
    cursor = p.nextCursor;
    onPage?.(++pages);
    expect(pages).toBeLessThan(100);
  } while (cursor);
  return { out, safe, pages };
}

const T0 = 1_793_600_000;

describe('listOrders (#221, POST /order/202309/orders/search)', () => {
  it('lọc update_time_ge theo giây, xếp update_time tăng, trang 100, không gửi page_token ở trang thường', async () => {
    const { calls, methods } = fakeSan(searchHandler(new Map([['A', { update: T0 + 5 }]])));
    const page = await methods.listOrders!(TOKEN, new Date(T0 * 1000 + 999), null);
    expect(page).toEqual({ orders: [expect.objectContaining({ externalOrderId: 'A', updatedAt: new Date((T0 + 5) * 1000) })], nextCursor: null, safeUntil: null });
    expect(calls[0]!.method).toBe('POST');
    expect(Object.fromEntries(['page_size', 'sort_field', 'sort_order', 'shop_cipher'].map((k) => [k, calls[0]!.query.get(k)]))).toEqual({
      page_size: '100',
      sort_field: 'update_time',
      sort_order: 'ASC',
      shop_cipher: 'ROW_c',
    });
    expect(calls[0]!.query.has('page_token')).toBe(false);
    expect(calls[0]!.body).toEqual({ update_time_ge: T0 });
  });

  it('lật nhiều trang: không sót, không trùng, updatedAt không giảm; trang sau gọi lại từ giây của đơn cuối', async () => {
    // 250 đơn, mỗi giây 2 đơn: trang cắt giữa một giây thì đơn cùng giây trả lần nữa và bị bỏ trùng.
    const orders = new Map(Array.from({ length: 250 }, (_, i) => [`O${String(i).padStart(3, '0')}`, { update: T0 + Math.floor(i / 2) }]));
    const { calls, methods } = fakeSan(searchHandler(orders));
    const { out, safe } = await drain((c) => methods.listOrders!(TOKEN, new Date(T0 * 1000), c));
    expect(out.map((o) => o.externalOrderId)).toEqual([...orders.keys()]);
    expect(safe).toEqual([]);
    expect(calls.every((c) => !c.query.has('page_token'))).toBe(true);
    expect(calls[1]!.body).toEqual({ update_time_ge: T0 + 49 });
  });

  it('đơn ở trang đã đọc đổi giữa hai trang (sàn lật theo offset) không làm sót đơn khác', async () => {
    const orders = new Map(Array.from({ length: 250 }, (_, i) => [`O${String(i).padStart(3, '0')}`, { update: T0 + i }]));
    const { methods } = fakeSan(searchHandler(orders));
    const { out } = await drain(
      (c) => methods.listOrders!(TOKEN, new Date(T0 * 1000), c),
      (n) => {
        if (n === 1) orders.set('O000', { update: T0 + 10_000 });
      },
    );
    const ids = new Set(out.map((o) => o.externalOrderId));
    for (const id of orders.keys()) expect(ids).toContain(id);
    expect(out.at(-1)).toMatchObject({ externalOrderId: 'O000' });
  });

  it('hơn 100 đơn cùng một giây: lật nhóm giây đó bằng page_token trong [s, s+1), rồi sang s+1', async () => {
    const orders = new Map<string, FakeOrder>(Array.from({ length: 230 }, (_, i) => [`S${String(i).padStart(3, '0')}`, { update: T0 }]));
    orders.set('Z', { update: T0 + 3 });
    const { calls, methods } = fakeSan(searchHandler(orders));
    const { out, safe } = await drain((c) => methods.listOrders!(TOKEN, new Date(T0 * 1000), c));
    expect(new Set(out.map((o) => o.externalOrderId)).size).toBe(231);
    expect(out).toHaveLength(231);
    expect(safe).toEqual([]);
    expect(calls.some((c) => c.body?.update_time_lt === T0 + 1 && c.query.get('page_token') === '100')).toBe(true);
    expect(calls.at(-1)!.body).toEqual({ update_time_ge: T0 + 1 });
  });

  it('đơn trong nhóm cùng giây đổi giữa lúc lật nhóm: báo safeUntil = giây đó', async () => {
    const orders = new Map<string, FakeOrder>(Array.from({ length: 230 }, (_, i) => [`S${String(i).padStart(3, '0')}`, { update: T0 }]));
    const { methods } = fakeSan(searchHandler(orders));
    const { safe } = await drain(
      (c) => methods.listOrders!(TOKEN, new Date(T0 * 1000), c),
      (n) => {
        // Trang 2 là trang đầu của nhóm; sau đó một đơn rời nhóm, offset trượt.
        if (n === 2) orders.set('S000', { update: T0 + 50 });
      },
    );
    expect(safe).toEqual([new Date(T0 * 1000)]);
  });

  it('trang rỗng thì hết', async () => {
    const { methods } = fakeSan(searchHandler(new Map()));
    expect(await methods.listOrders!(TOKEN, new Date(T0 * 1000), null)).toEqual({ orders: [], nextCursor: null, safeUntil: null });
  });
});

describe('listOpenOrders (#198, #221)', () => {
  it('đi từng trạng thái chưa xong theo vòng đời, không lọc update_time, gộp đơn của mọi trạng thái', async () => {
    const orders = new Map<string, FakeOrder>([
      ['U', { update: T0 + 1, status: 'UNPAID' }],
      ['H', { update: T0 + 2, status: 'ON_HOLD' }],
      ['A', { update: T0 + 3, status: 'AWAITING_SHIPMENT' }],
      ['T', { update: T0 + 4, status: 'IN_TRANSIT' }],
      ['D', { update: T0 + 5, status: 'DELIVERED' }],
      ['X', { update: T0 + 6, status: 'CANCELLED' }],
    ]);
    const { calls, methods } = fakeSan(searchHandler(orders));
    const { out, safe } = await drain((c) => methods.listOpenOrders!(TOKEN, c));
    expect(out.map((o) => o.externalOrderId)).toEqual(['U', 'H', 'A', 'T']);
    expect(safe).toEqual([]);
    expect(calls.map((c) => c.body)).toEqual(TIKTOK_OPEN_STATUSES.map((s) => ({ order_status: s })));
  });
});

/** Đơn chi tiết theo phản hồi thật của Get Order Detail 202507 (đơn 586945714962334730, đã tách 2 kiện, đã giao). */
function deliveredOrder() {
  return {
    id: '586945714962334730',
    status: 'DELIVERED',
    create_time: 1793696417,
    update_time: 1793697860,
    paid_time: 1793696417,
    rts_sla_time: 1793793600,
    delivery_time: 1793697360,
    is_cod: false,
    payment_method_name: 'Credit/debit card',
    buyer_message: '',
    shipping_type: 'TIKTOK',
    shipping_provider: 'TT Virtual# JNT express',
    packages: [{ id: '1217168734748509194' }, { id: '1217168734748574730' }],
    payment: {
      currency: 'VND',
      original_shipping_fee: '300',
      shipping_fee: '300',
      shipping_fee_cofunded_discount: '0',
      shipping_fee_platform_discount: '0',
      shipping_fee_seller_discount: '0',
      sub_total: '311000',
      total_amount: '311300',
    },
    recipient_address: {
      address_detail: '11******************',
      address_line1: '11******************',
      address_line2: '',
      district_info: [
        { address_level: 'L0', address_level_name: 'Country', address_name: 'Vietnam', iso_code: 'VN' },
        { address_level: 'L1', address_level_name: 'city', address_name: 'Ha Noi', iso_code: 'HN' },
        { address_level: 'L2', address_level_name: 'urban district', address_name: 'Cau Giay' },
        { address_level: 'L3', address_level_name: 'ward', address_name: 'Tr*******' },
      ],
      full_address: 'Vietnam, Ha Noi, Cau Giay, Tr*******,11******************',
      name: 'a***-vn2',
      phone_number: '(+86)123******43',
      postal_code: '',
      region_code: 'VN',
    },
    line_items: [
      {
        id: '586945714962531338',
        display_status: 'DELIVERED',
        package_status: 'COMPLETED',
        package_id: '1217168734748574730',
        tracking_number: '179154473201031',
        original_price: '61000',
        sale_price: '61000',
        seller_discount: '0',
        platform_discount: '0',
        product_id: '1738338487553328657',
        product_name: 'Cốc sứ TEST',
        seller_sku: 'CM-TEST-MUG-TRANG',
        sku_id: '1738338453674427921',
        sku_image: 'https://img.test/mug.jpeg',
        sku_name: 'Trắng',
        shipping_provider_name: 'TT Virtual# JNT express',
      },
      {
        id: '586945714962465802',
        display_status: 'DELIVERED',
        package_status: 'COMPLETED',
        package_id: '1217168734748509194',
        tracking_number: '179154473203342',
        original_price: '250000',
        sale_price: '240000',
        seller_discount: '6000',
        platform_discount: '4000',
        product_id: '1738350612753122833',
        product_name: 'Sandbox Default Test Product 1G',
        seller_sku: 'SANDBOX-DEFAULT-52',
        sku_id: '1738350612634830353',
        sku_name: 'Màu trắng,00',
        item_tax: [{ tax_amount: '1000', tax_type: 'SALES_TAX' }],
      },
    ],
  };
}

describe('toTiktokOrder (GET /order/202507/orders)', () => {
  it('đơn đã giao, hai kiện: mỗi món một kiện, vận đơn, tiền chuỗi, mốc giao, địa chỉ đã che giữ nguyên', () => {
    const o = toTiktokOrder(deliveredOrder());
    expect(o).toMatchObject({
      externalOrderId: '586945714962334730',
      rawStatus: 'DELIVERED',
      paid: true,
      isCod: false,
      placedAt: new Date(1793696417 * 1000),
      updatedAt: new Date(1793697860 * 1000),
      shipBy: new Date(1793793600 * 1000),
      deliveredAt: new Date(1793697360 * 1000),
      shippingFee: '300',
      cancelRequested: false,
      info: {
        platformPaymentMethod: 'Credit/debit card',
        buyerNote: null,
        shippingFeeOriginal: '300',
        shippingFeeDiscountSeller: '0',
        shippingFeeDiscountPlatform: '0',
      },
      shippingAddress: {
        name: 'a***-vn2',
        phone: '(+86)123******43',
        address: '11******************, Cau Giay, Ha Noi',
        ward: 'Tr*******',
        postCode: null,
      },
    });
    expect(o.shippingAddress!.raw).toMatchObject({ full_address: 'Vietnam, Ha Noi, Cau Giay, Tr*******,11******************', district_L3: 'Tr*******' });
    expect(o.lines.map((l) => [l.externalLineId, l.sellerSku, l.packageCode, l.trackingCode, l.rawStatus, l.status])).toEqual([
      ['586945714962531338', 'CM-TEST-MUG-TRANG', '1217168734748574730', '179154473201031', 'DELIVERED', 'delivered'],
      ['586945714962465802', 'SANDBOX-DEFAULT-52', '1217168734748509194', '179154473203342', 'DELIVERED', 'delivered'],
    ]);
    expect(o.lines[1]).toMatchObject({
      unitPrice: '250000',
      sellerDiscount: '6000',
      platformDiscount: '4000',
      info: { paidPrice: '240000', taxAmount: '1000', externalSkuId: '1738350612634830353', externalProductId: '1738350612753122833', attributesLabel: 'Màu trắng,00' },
      shipping: { shipmentProvider: 'TT Virtual# JNT express', shippingType: 'TIKTOK', promisedShippingAt: new Date(1793793600 * 1000) },
    });
    expect(o.lines[1]!.shipping.shipmentProvider).toBe('TT Virtual# JNT express');
  });

  it('đơn ON_HOLD: món `display_status: UNKNOWN` lấy trạng thái đơn, chưa có kiện, địa chỉ rỗng là null', () => {
    const o = toTiktokOrder({
      id: '587022741397144586',
      status: 'ON_HOLD',
      create_time: 1793971210,
      update_time: 1793971211,
      payment: { shipping_fee: '300' },
      recipient_address: { address_detail: '', name: '', phone_number: '', first_name: '', last_name: '' },
      line_items: [{ id: 'L1', display_status: 'UNKNOWN', seller_sku: 'CM-TEST-MUG-TRANG', original_price: '61000' }],
    });
    expect(o.shippingAddress).toBeNull();
    expect(o.shipBy).toBeNull();
    expect(o.lines[0]).toMatchObject({ rawStatus: 'ON_HOLD', status: 'pending', packageCode: null, trackingCode: null });
  });

  it('khách xin huỷ, COD, món huỷ do người bán, thiếu mốc bắt buộc thì rejected', () => {
    const base = { id: 'O', create_time: 1, update_time: 2, line_items: [] };
    expect(toTiktokOrder({ ...base, status: 'AWAITING_SHIPMENT', is_buyer_request_cancel: true, is_cod: true })).toMatchObject({ cancelRequested: true, isCod: true, paid: true });
    expect(toTiktokOrder({ ...base, status: 'UNPAID' }).paid).toBe(false);
    const cancelled = toTiktokOrder({ ...base, status: 'CANCELLED', line_items: [{ id: 'L', display_status: 'CANCELLED', cancel_user: 'SELLER', cancel_reason: 'Out of stock' }] });
    expect(cancelled.lines[0]).toMatchObject({ status: 'cancelled', info: { cancelInitiator: 'seller', cancelKind: 'cancellation', cancelReason: 'Out of stock' } });
    const system = toTiktokOrder({ ...base, status: 'CANCELLED', line_items: [{ id: 'L', display_status: 'CANCELLED', cancel_user: 'SYSTEM' }] });
    expect(system.lines[0]!.info.cancelInitiator).toBe('platform');
    expect(() => toTiktokOrder({ id: 'O', status: 'ON_HOLD', line_items: [] })).toThrow(MarketplaceError);
  });
});

describe('tiktokLineStatus: trạng thái TikTok → trạng thái kiện', () => {
  it.each([
    ['UNPAID', '', 'UNPAID', 'pending'],
    ['UNKNOWN', '', 'ON_HOLD', 'pending'],
    ['AWAITING_SHIPMENT', 'TO_FULFILL', 'AWAITING_SHIPMENT', 'pending'],
    ['AWAITING_SHIPMENT', 'PROCESSING', 'PARTIALLY_SHIPPING', 'awaiting_pickup'],
    ['AWAITING_COLLECTION', 'PROCESSING', 'AWAITING_SHIPMENT', 'awaiting_pickup'],
    ['IN_TRANSIT', 'FULFILLING', 'IN_TRANSIT', 'in_transit'],
    ['DELIVERED', 'COMPLETED', 'DELIVERED', 'delivered'],
    ['COMPLETED', 'CANCELLED', 'COMPLETED', 'delivered'],
    ['CANCELLED', 'CANCELLED', 'CANCELLED', 'cancelled'],
    ['', 'FULFILLING', 'PARTIALLY_SHIPPING', 'in_transit'],
    ['LẠ', 'LẠ', 'LẠ', null],
  ] as const)('display %s, kiện %s, đơn %s → %s', (display, pkg, order, want) => {
    expect(tiktokLineStatus(display, pkg, order)).toBe(want);
  });
});

describe('getOrders / getOrder', () => {
  const detailHandler = (have: Set<string>) => (c: Call) =>
    ok({ orders: (c.query.get('ids') ?? '').split(',').filter((id) => have.has(id)).map((id) => ({ ...deliveredOrder(), id })) });

  it('lô tối đa 50 mã, nối bằng dấu phẩy, bỏ mã trùng, trả theo thứ tự refs', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `O${i}`);
    const { calls, methods } = fakeSan(detailHandler(new Set(ids)));
    const at = new Date(0);
    const refs = [...ids, 'O0'].reverse().map((id) => ({ externalOrderId: id, placedAt: at, updatedAt: at }));
    const out = await methods.getOrders!(TOKEN, refs);
    expect(out.map((o) => o.externalOrderId)).toEqual(refs.map((r) => r.externalOrderId));
    expect(calls.map((c) => [c.method, c.path, c.query.get('ids')!.split(',').length])).toEqual([
      ['GET', '/order/202507/orders', 50],
      ['GET', '/order/202507/orders', 50],
      ['GET', '/order/202507/orders', 20],
    ]);
    expect(await methods.getOrders!(TOKEN, [])).toEqual([]);
  });

  it('sàn không trả đơn được hỏi: rejected order_not_found', async () => {
    const { methods } = fakeSan(detailHandler(new Set()));
    await expect(methods.getOrder!(TOKEN, 'O9')).rejects.toMatchObject({ kind: 'rejected', platformCode: 'order_not_found' });
  });
});

describe('tách kiện, giao kiện (#221)', () => {
  it('splitAttributes đọc can_split, must_split_reasons của đúng đơn', async () => {
    const { calls, methods } = fakeSan(() =>
      ok({
        split_attributes: [
          {
            order_id: '587022741397144586',
            can_split: true,
            must_split: true,
            must_split_reasons: [{ type: 'CATEGORY_ITEM_LIMITATION', category_id: '600001', max_count: '1' }],
          },
        ],
      }),
    );
    expect(await methods.splitAttributes!(TOKEN, '587022741397144586')).toEqual({
      canSplit: true,
      mustSplit: true,
      reason: null,
      mustSplitReasons: [{ type: 'CATEGORY_ITEM_LIMITATION', externalCategoryId: '600001', maxCount: 1 }],
    });
    expect([calls[0]!.method, calls[0]!.path, calls[0]!.query.get('order_ids')]).toEqual(['GET', '/fulfillment/202309/orders/split_attributes', '587022741397144586']);
  });

  it('đơn còn ON_HOLD: sàn trả 21001008, adapter báo rejected giữ mã', async () => {
    const { methods } = fakeSan(() => json({ code: 21001008, message: 'cannot find fulfill_order, main_order_id=1' }));
    await expect(methods.splitAttributes!(TOKEN, '1')).rejects.toMatchObject({ kind: 'rejected', platformCode: '21001008' });
  });

  it('splitOrder gửi nhóm id chuỗi số từ 1, trả mã kiện mới theo thứ tự nhóm', async () => {
    const { calls, methods } = fakeSan(() =>
      ok({ packages: [{ id: 'P2', splittable_group_id: '2' }, { id: 'P1', splittable_group_id: '1' }] }),
    );
    expect(await methods.splitOrder!(TOKEN, '587022741397144586', [['L1', 'L2'], ['L3']])).toEqual(['P1', 'P2']);
    expect([calls[0]!.method, calls[0]!.path]).toEqual(['POST', '/fulfillment/202309/orders/587022741397144586/split']);
    expect(calls[0]!.body).toEqual({
      splittable_groups: [
        { id: '1', order_line_item_ids: ['L1', 'L2'] },
        { id: '2', order_line_item_ids: ['L3'] },
      ],
    });
  });

  it('splitOrder dưới hai nhóm hay nhóm rỗng: rejected, không gọi sàn', async () => {
    const { calls, methods } = fakeSan(() => ok({}));
    await expect(methods.splitOrder!(TOKEN, 'O', [['L1']])).rejects.toMatchObject({ kind: 'rejected', platformCode: 'invalid_split' });
    await expect(methods.splitOrder!(TOKEN, 'O', [['L1'], []])).rejects.toMatchObject({ platformCode: 'invalid_split' });
    expect(calls).toHaveLength(0);
  });

  it('shipPackage gọi POST packages/{id}/ship, đổi cách bàn giao sang mã của sàn', async () => {
    const { calls, methods } = fakeSan(() => ok({}));
    await methods.shipPackage!(TOKEN, '1217675261456319498');
    await methods.shipPackage!(TOKEN, '1217675261456319498', { handover: 'drop_off' });
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ['POST', '/fulfillment/202309/packages/1217675261456319498/ship', {}],
      ['POST', '/fulfillment/202309/packages/1217675261456319498/ship', { handover_method: 'DROP_OFF' }],
    ]);
  });

  it('shipPackage: kiện đã giao (11006021) là rejected giữ mã', async () => {
    const { methods } = fakeSan(() => json({ code: 11006021, message: 'Package has been shipped.' }));
    await expect(methods.shipPackage!(TOKEN, 'P')).rejects.toMatchObject({ kind: 'rejected', platformCode: '11006021' });
  });
});

describe('createTiktokAdapter', () => {
  it('có đủ năng lực đơn và kiện', () => {
    const a = createTiktokAdapter(config, vi.fn<typeof fetch>());
    for (const m of ['listOrders', 'listOpenOrders', 'getOrder', 'getOrders', 'splitAttributes', 'splitOrder', 'shipPackage'] as const) {
      expect(typeof a[m]).toBe('function');
    }
  });
});
