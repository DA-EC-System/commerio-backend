import { describe, expect, it, vi } from 'vitest';
import { createLazadaAdapter, lazadaPackageStatus } from '#src/modules/channel/channel/service/marketplaces/lazada.ts';

const config = { appKey: 'k', appSecret: 's', redirectUrl: 'https://app/cb', apiUrl: 'https://api.test/rest', authUrl: 'https://auth.test' };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const query = (fn: ReturnType<typeof vi.fn>, n: number) => Object.fromEntries(new URL(String(fn.mock.calls[n]![0])).searchParams);

// Rút gọn từ response thật của shop thử (29/10/2026), dữ liệu khách Lazada đã che sẵn.
const order = {
  order_id: 533732107780318,
  created_at: '2026-10-29 14:41:18 +0700',
  updated_at: '2026-10-29 14:41:34 +0700',
  price: '23456.00',
  payment_method: 'COD',
  statuses: ['packed'],
  shipping_fee: 0,
  is_cancel_pending: false,
  need_cancel_confirm: false,
  address_shipping: { first_name: 'G***l', last_name: '', phone: '84********22', address1: '6**8', address4: 'P**a', address5: 'T**a', city: 'Phường Tân Sơn Hòa' },
};
const item = {
  order_item_id: 533732107880318,
  order_id: 533732107780318,
  sku: 'AO-THUN-M',
  name: 'Áo thun cổ tròn',
  status: 'packed',
  item_price: 23456,
  paid_price: 20456,
  voucher_seller: 2000,
  voucher_platform: 1000,
  package_id: 'FP070211665002474',
  tracking_code: 'SOF_FP070211665002474',
  fulfillment_sla: 'Vui lòng đảm bảo đơn hàng sẽ được giao trước 2026-11-04 23:59:19 để tuân thủ FFR_153.1 hrs_blue',
};

describe('Lazada: trạng thái món → trạng thái kiện (#105 A3)', () => {
  it.each([
    ['unpaid', 'pending'],
    ['pending', 'pending'],
    ['topack', 'pending'],
    ['packed', 'packed'],
    ['ready_to_ship', 'awaiting_pickup'],
    ['toship', 'awaiting_pickup'],
    ['shipped', 'in_transit'],
    ['shipping', 'in_transit'],
    ['delivered', 'delivered'],
    ['failed_delivery', 'delivery_failed'],
    ['failed', 'delivery_failed'],
    ['shipped_back', 'returning'],
    ['shipped_back_success', 'returned'],
    ['returned', 'returned'],
    ['shipped_back_failed', 'return_failed'],
    ['lost', 'lost'],
    ['lost_by_3pl', 'lost'],
    ['damaged_by_3pl', 'lost'],
    ['package_scrapped', 'lost'],
    ['canceled', 'cancelled'],
    ['something_new', null],
  ])('%s → %s', (raw, expected) => {
    expect(lazadaPackageStatus(raw)).toBe(expected);
  });
});

describe('Lazada: kéo đơn (#105)', () => {
  it('listOrders gửi update_after giờ VN, xếp theo updated_at tăng dần, báo còn trang', async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ ...order, order_id: i }));
    const fn = vi.fn().mockResolvedValueOnce(json({ code: '0', data: { countTotal: 150, orders: page } }));
    const res = await createLazadaAdapter(config, fn).listOrders!('t', new Date('2026-10-28T17:00:00Z'), 0);
    expect(res.hasMore).toBe(true);
    expect(res.orders[1]).toEqual({
      externalOrderId: '1',
      placedAt: new Date('2026-10-29T07:41:18Z'),
      updatedAt: new Date('2026-10-29T07:41:34Z'),
    });
    expect(query(fn, 0)).toMatchObject({
      update_after: '2026-10-29T00:00:00+07:00',
      sort_by: 'updated_at',
      sort_direction: 'ASC',
      limit: '100',
      offset: '0',
      access_token: 't',
    });
  });

  it('getOrder gộp đơn và món thành đơn chuẩn hoá', async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce(json({ code: '0', data: order }))
      .mockResolvedValueOnce(json({ code: '0', data: [item, { ...item, order_item_id: 2, status: 'canceled', package_id: '' }] }));
    const o = await createLazadaAdapter(config, fn).getOrder!('t', '533732107780318');
    expect(query(fn, 0)).toMatchObject({ order_id: '533732107780318' });
    expect(new URL(String(fn.mock.calls[1]![0])).pathname).toBe('/rest/order/items/get');
    expect(o).toMatchObject({
      externalOrderId: '533732107780318',
      rawStatus: 'packed',
      paid: true,
      isCod: true,
      placedAt: new Date('2026-10-29T07:41:18Z'),
      updatedAt: new Date('2026-10-29T07:41:34Z'),
      shipBy: new Date('2026-11-04T16:59:19Z'),
      shippingFee: '0',
      cancelRequested: false,
      shippingAddress: { name: 'G***l', phone: '84********22', address: '6**8, P**a, T**a, Phường Tân Sơn Hòa' },
    });
    expect(o.lines[0]).toEqual({
      externalLineId: '533732107880318',
      sellerSku: 'AO-THUN-M',
      productName: 'Áo thun cổ tròn',
      unitPrice: '23456',
      sellerDiscount: '2000',
      platformDiscount: '1000',
      packageCode: 'FP070211665002474',
      trackingCode: 'SOF_FP070211665002474',
      rawStatus: 'packed',
      status: 'packed',
    });
    expect(o.lines[1]).toMatchObject({ packageCode: null, status: 'cancelled' });
  });

  it('đơn chưa trả: paid false; khách xin huỷ: cancelRequested', async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce(json({ code: '0', data: { ...order, statuses: ['unpaid'], payment_method: 'MIXEDCARD', need_cancel_confirm: true } }))
      .mockResolvedValueOnce(json({ code: '0', data: [{ ...item, status: 'unpaid', fulfillment_sla: '' }] }));
    const o = await createLazadaAdapter(config, fn).getOrder!('t', '1');
    expect(o).toMatchObject({ paid: false, isCod: false, cancelRequested: true, shipBy: null });
  });

  // Gọi thật 29/10: gọi dồn `/order/items/get` thì Lazada trả `SellerCallLimit` "this ban will last 1 seconds".
  it('bị chặn tần suất thì chờ rồi gọi lại một lần; lần hai vẫn bị chặn là lỗi tạm', async () => {
    vi.useFakeTimers();
    try {
      const limit = () => json({ code: 'SellerCallLimit', type: 'ISV', message: 'this ban will last 1 seconds' });
      const fn = vi.fn().mockResolvedValueOnce(limit()).mockResolvedValueOnce(json({ code: '0', data: { countTotal: 0, orders: [] } }));
      const ok = createLazadaAdapter(config, fn).listOrders!('t', new Date(), 0);
      await vi.advanceTimersByTimeAsync(1500);
      await expect(ok).resolves.toEqual({ orders: [], hasMore: false });

      const fn2 = vi.fn().mockImplementation(async () => limit());
      const fail = createLazadaAdapter(config, fn2).listOrders!('t', new Date(), 0);
      const check = expect(fail).rejects.toMatchObject({ kind: 'unavailable', platformCode: 'SellerCallLimit' });
      await vi.advanceTimersByTimeAsync(1500);
      await check;
      expect(fn2).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('token sai ném unauthorized', async () => {
    const fn = vi.fn().mockResolvedValueOnce(json({ code: 'IllegalAccessToken', type: 'ISV', message: 'bad' }));
    await expect(createLazadaAdapter(config, fn).getOrder!('t', '1')).rejects.toMatchObject({ kind: 'unauthorized' });
  });
});
