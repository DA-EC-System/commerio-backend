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
  address_shipping: { first_name: 'G***l', last_name: '', phone: '84********22', address1: '6**8', address4: 'P**a', address5: 'T**a', city: 'Phường Tân Sơn Hòa', country: 'Vietnam', post_code: '', addressDistrict: '' },
  buyer_note: '',
  shipping_fee_original: 0,
  shipping_fee_discount_seller: 0,
  shipping_fee_discount_platform: 0,
  // Dữ liệu cá nhân của người mua (#260 "Không lưu"): không được lọt vào đơn chuẩn hoá.
  recipient_info: { identify_no: 'ID-SECRET', passport_no: 'PP-SECRET', detail_address: 'DA-SECRET' },
  tax_code: 'TAX-SECRET',
  national_registration_number: 'NRN-SECRET',
  branch_number: 'BR-SECRET',
  address_billing: { first_name: 'BILL-SECRET' },
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
  // Trường đo trên payload thật 05/11/2026 (#260).
  sku_id: '117546388086',
  shop_sku: '13502898086_VNAMZ-117546388086',
  product_id: '13502898086',
  variation: '',
  product_main_image: 'https://img.lazcdn.com/a.jpg',
  tax_amount: 909,
  shipping_amount: 0,
  wallet_credits: 0,
  shipment_provider: 'Drop-off: J&T VN, Delivery: J&T VN',
  shipping_provider_type: 'standard',
  shipping_type: 'Dropshipping',
  promised_shipping_time: '',
  reason: '',
  reason_detail: '',
  cancel_return_initiator: 'null-null',
  return_status: '',
  digital_delivery_info: 'buyer-SECRET@alitest.xyz',
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
    const res = await createLazadaAdapter(config, fn).listOrders!('t', new Date('2026-10-28T17:00:00Z'), null);
    expect(res.nextCursor).not.toBeNull();
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
      info: {
        thumbnailUrl: 'https://img.lazcdn.com/a.jpg',
        attributesLabel: null,
        externalSkuId: '117546388086',
        externalShopSku: '13502898086_VNAMZ-117546388086',
        externalProductId: '13502898086',
        paidPrice: '20456',
        taxAmount: '909',
        shippingAmount: '0',
        walletCredits: '0',
        cancelReason: null,
        cancelReasonDetail: null,
        cancelInitiator: null,
        cancelKind: null,
        reverseOrderId: null,
        returnStatus: null,
      },
      shipping: {
        shipmentProvider: 'Drop-off: J&T VN, Delivery: J&T VN',
        shippingProviderType: 'standard',
        shippingType: 'Dropshipping',
        promisedShippingAt: null,
      },
    });
    expect(o.lines[1]).toMatchObject({ packageCode: null, status: 'cancelled' });
    expect(o.info).toEqual({
      platformPaymentMethod: 'COD',
      buyerNote: null,
      shippingFeeOriginal: '0',
      shippingFeeDiscountSeller: '0',
      shippingFeeDiscountPlatform: '0',
    });
    // Phường lấy từ `city` (Lazada che tỉnh, đường; không còn quận); khoá thô giữ nguyên, bỏ khoá rỗng.
    expect(o.shippingAddress).toEqual({
      name: 'G***l',
      phone: '84********22',
      address: '6**8, P**a, T**a, Phường Tân Sơn Hòa',
      ward: 'Phường Tân Sơn Hòa',
      postCode: null,
      raw: { address1: '6**8', address4: 'P**a', address5: 'T**a', city: 'Phường Tân Sơn Hòa', country: 'Vietnam' },
    });
    expect(JSON.stringify(o)).not.toMatch(/SECRET/);
  });

  it('món có biến thể, ghi chú khách, món bị huỷ/trả: chuẩn hoá người huỷ và loại (#260 A3)', async () => {
    const lines = [
      { ...item, order_item_id: 1, variation: 'Màu:Đỏ, Size:M' },
      { ...item, order_item_id: 2, status: 'canceled', reason: 'Đổi ý', reason_detail: 'Muốn màu khác', cancel_return_initiator: 'cancellation-customer', reverse_order_id: 777 },
      { ...item, order_item_id: 3, status: 'canceled', cancel_return_initiator: 'cancellation-seller' },
      { ...item, order_item_id: 4, status: 'canceled', cancel_return_initiator: 'cancellation-internal' },
      { ...item, order_item_id: 5, status: 'shipped_back', cancel_return_initiator: 'cancellation-failed Delivery' },
      { ...item, order_item_id: 6, status: 'returned', cancel_return_initiator: 'return-customer', return_status: 'refund_success' },
      { ...item, order_item_id: 7, cancel_return_initiator: 'refund-internal' },
      { ...item, order_item_id: 8, cancel_return_initiator: 'swap-robot' },
      { ...item, order_item_id: 9, promised_shipping_time: '2026-11-06 23:59:02 +0700', paid_price: undefined },
    ];
    const fn = vi
      .fn()
      .mockResolvedValueOnce(json({ code: '0', data: { ...order, payment_method: 'MIXEDCARD', buyer_note: 'Giao giờ hành chính' } }))
      .mockResolvedValueOnce(json({ code: '0', data: lines }));
    const o = await createLazadaAdapter(config, fn).getOrder!('t', '1');
    expect(o.info).toMatchObject({ platformPaymentMethod: 'MIXEDCARD', buyerNote: 'Giao giờ hành chính' });
    const info = o.lines.map((l) => l.info);
    expect(info[0]!.attributesLabel).toBe('Màu:Đỏ, Size:M');
    expect(info[1]).toMatchObject({ cancelReason: 'Đổi ý', cancelReasonDetail: 'Muốn màu khác', cancelInitiator: 'buyer', cancelKind: 'cancellation', reverseOrderId: '777' });
    expect(info.slice(2, 8).map((i) => [i.cancelInitiator, i.cancelKind])).toEqual([
      ['seller', 'cancellation'],
      ['platform', 'cancellation'],
      [null, 'failed_delivery'],
      ['buyer', 'return'],
      ['platform', 'refund'],
      [null, null],
    ]);
    expect(info[5]!.returnStatus).toBe('refund_success');
    expect(o.lines[8]!.shipping.promisedShippingAt).toEqual(new Date('2026-11-06T16:59:02Z'));
    expect(info[8]!.paidPrice).toBeNull();
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
      const ok = createLazadaAdapter(config, fn).listOrders!('t', new Date(), null);
      await vi.advanceTimersByTimeAsync(1500);
      await expect(ok).resolves.toEqual({ orders: [], nextCursor: null, safeUntil: null });

      const fn2 = vi.fn().mockImplementation(async () => limit());
      const fail = createLazadaAdapter(config, fn2).listOrders!('t', new Date(), null);
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

describe('Lazada: huỷ đơn (#105 PR 2)', () => {
  it('cancelReasons gọi validate với danh sách món, trả lý do của sàn', async () => {
    const fn = vi.fn().mockResolvedValueOnce(
      json({ code: '0', data: { tip_content: 'stock will be set as 0', tip_type: 'warn', reason_options: [{ reason_name: 'Hết hàng', reason_id: '1000017' }] } }),
    );
    expect(await createLazadaAdapter(config, fn).cancelReasons!('t', '9', ['91', '92'])).toEqual([{ id: '1000017', label: 'Hết hàng' }]);
    expect(new URL(String(fn.mock.calls[0]![0])).pathname).toBe('/rest/order/reverse/cancel/validate');
    expect(query(fn, 0)).toMatchObject({ order_id: '9', order_item_id_list: '["91","92"]' });
  });

  it('sàn không cho huỷ (không có lý do nào) thì ném rejected kèm câu của sàn', async () => {
    const fn = vi.fn().mockResolvedValueOnce(json({ code: '0', data: { tip_content: 'Đơn đã bàn giao', tip_type: 'error', reason_options: [] } }));
    await expect(createLazadaAdapter(config, fn).cancelReasons!('t', '9', ['91'])).rejects.toMatchObject({
      kind: 'rejected',
      platformCode: 'not_cancellable',
      platformMessage: 'Đơn đã bàn giao',
    });
  });

  it('cancelOrder gửi lý do; tip_type error là sàn từ chối', async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce(json({ code: '0', data: { tip_type: 'warn', tip_content: 'stock will be set as 0' } }))
      .mockResolvedValueOnce(json({ code: '0', data: { tip_type: 'error', tip_content: 'Không huỷ được' } }));
    const a = createLazadaAdapter(config, fn);
    await a.cancelOrder!('t', '9', ['91'], '1000017');
    expect(new URL(String(fn.mock.calls[0]![0])).pathname).toBe('/rest/order/reverse/cancel/create');
    expect(query(fn, 0)).toMatchObject({ order_id: '9', order_item_id_list: '["91"]', reason_id: '1000017' });
    await expect(a.cancelOrder!('t', '9', ['91'], '1000017')).rejects.toMatchObject({ kind: 'rejected', platformMessage: 'Không huỷ được' });
  });

  it('decideCancelRequest tìm đơn ngược loại CANCEL theo mã đơn rồi gửi quyết định', async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce(json({ code: '0', result: { items: [{ reverse_order_id: '777', request_type: 'CANCEL', trade_order_id: '9' }] } }))
      .mockResolvedValueOnce(json({ code: '0' }));
    await createLazadaAdapter(config, fn).decideCancelRequest!('t', '9', true);
    expect(new URL(String(fn.mock.calls[0]![0])).pathname).toBe('/rest/reverse/getreverseordersforseller');
    expect(query(fn, 0)).toMatchObject({ trade_order_id: '9', request_type_list: '["CANCEL"]', page_no: '1' });
    expect(new URL(String(fn.mock.calls[1]![0])).pathname).toBe('/rest/order/reverse/cancel/seller/decide');
    expect(query(fn, 1)).toMatchObject({ reverse_order_id: '777', agree_cancel: 'true' });
  });

  it('không có yêu cầu huỷ trên sàn thì ném rejected', async () => {
    const fn = vi.fn().mockResolvedValueOnce(json({ code: '0', result: { items: [] } }));
    await expect(createLazadaAdapter(config, fn).decideCancelRequest!('t', '9', false)).rejects.toMatchObject({
      kind: 'rejected',
      platformCode: 'cancel_request_not_found',
    });
  });
});
