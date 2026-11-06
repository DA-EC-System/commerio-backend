// Huỷ đơn và trả hàng TikTok (#227). Fixture theo docv2 (search-returns-202602, search-cancellations-202602,
// get-aftersale-eligibility-202602, get-decision-eligibility-202601, tra 07/11/2026) và phản hồi thật của shop thử VN
// ngày 07/11/2026. Trạng thái app theo Documents/kiem-thu/ca-theo-so-do.md mục D3 (mã ca ghi ở từng dòng).
import { describe, expect, it, vi } from 'vitest';
import { packTiktokToken } from '#src/modules/channel/channel/service/marketplaces/tiktok-client.ts';
import {
  tiktokCancellationStatus,
  tiktokCancelReasonLabel,
  tiktokReturnStatus,
} from '#src/modules/channel/channel/service/marketplaces/tiktok-returns.ts';
import { createTiktokAdapter } from '#src/modules/channel/channel/service/marketplaces/tiktok.ts';

const config = { appKey: 'k', appSecret: 's', serviceId: undefined, apiUrl: 'https://open.test', authUrl: 'https://auth.test' };
const TOKEN = packTiktokToken({ token: 'TTP_at', cipher: 'ROW_c', shopId: '7495013067939481105' });
const ORDER = '586945714962334730';
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const ok = (data: unknown) => json({ code: 0, message: 'Success', request_id: 'r', data });

type Call = { method: string; path: string; query: URLSearchParams; body: unknown };

/** Sàn giả theo đường dẫn; ghi lại từng request để kiểm method, query, body. */
function fakeSan(routes: Record<string, (c: Call) => Response>) {
  const calls: Call[] = [];
  const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
    const u = new URL(String(url));
    const call: Call = { method: init?.method ?? 'GET', path: u.pathname, query: u.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const route = routes[`${call.method} ${call.path}`];
    return route ? route(call) : json({ code: 36009009, message: 'Invalid path' });
  });
  return { adapter: createTiktokAdapter(config, fetchFn), calls };
}

// Phản hồi thật Search Returns 202602 (07/11/2026), rút gọn ảnh.
const REAL_RETURN = {
  combined_return_id: '0',
  create_time: 1793634765,
  discount_amount: [{ currency: 'VND', product_platform_discount: '0', product_seller_discount: '0' }],
  is_combined_return: false,
  order_id: '586932266789143562',
  refund_amount: { currency: 'VND', refund_shipping_fee: '300', refund_subtotal: '61000', refund_tax: '0', refund_total: '61300' },
  return_id: '4042912638661985290',
  return_line_items: [
    {
      order_line_item_id: '586932266789274634',
      product_name: 'Cốc sứ có quai Commerio TEST 350ml',
      refund_amount: { currency: 'VND', refund_total: '61300' },
      return_line_item_id: '4042912638662050826',
      seller_sku: 'CM-TEST-MUG-TRANG',
      sku_id: '1738338453674427921',
      sku_name: 'Trắng',
    },
  ],
  return_reason: 'ecom_order_to_ship_canceled_reason_better_price_RTS_RO',
  return_reason_text: 'Better price available',
  return_status: 'RETURN_OR_REFUND_REQUEST_COMPLETE',
  return_type: 'REFUND',
  role: 'BUYER',
  update_time: 1793634867,
};

const pendingBuyerCancel = {
  cancel_id: '4035318504086604100',
  order_id: ORDER,
  cancel_type: 'BUYER_CANCEL',
  cancel_status: 'CANCELLATION_REQUEST_PENDING',
  role: 'BUYER',
  cancel_reason: 'ecom_order_to_ship_canceled_reason_created_by_mistakes',
  cancel_reason_text: 'Order created by mistake',
  create_time: 1793600000,
  update_time: 1793600100,
  seller_next_action_response: [{ action: 'SELLER_RESPOND_BUYER_CANCEL', deadline: 1793772800 }],
  refund_amount: { currency: 'VND', refund_total: '61300' },
  cancel_line_items: [{ cancel_line_item_id: '1', order_line_item_id: '586945714962465802', sku_id: '9', seller_sku: 'A' }],
};

describe('tiktokReturnStatus: trạng thái sàn → trạng thái yêu cầu trả của app', () => {
  it.each([
    // [return_status, return_type, status, closeResult, ghi chú]
    ['RETURN_OR_REFUND_REQUEST_PENDING', 'RETURN_AND_REFUND', 'requested', null],
    ['RETURN_OR_REFUND_REQUEST_PENDING', 'REFUND', 'requested', null],
    ['AWAITING_BUYER_RESPONSE', 'RETURN_AND_REFUND', 'requested', null],
    ['REFUND_OR_RETURN_REQUEST_REJECT', 'RETURN_AND_REFUND', 'rejected', null], // D3-02
    ['AWAITING_BUYER_SHIP', 'RETURN_AND_REFUND', 'awaiting_return', null], // D3-01, D3-04 khi sàn xử lại
    ['BUYER_SHIPPED_ITEM', 'RETURN_AND_REFUND', 'awaiting_return', null],
    ['REJECT_RECEIVE_PACKAGE', 'RETURN_AND_REFUND', 'received', null],
    ['RETURN_OR_REFUND_REQUEST_SUCCESS', 'RETURN_AND_REFUND', 'received', null],
    ['RETURN_OR_REFUND_REQUEST_COMPLETE', 'RETURN_AND_REFUND', 'received', null],
    ['RETURN_OR_REFUND_REQUEST_SUCCESS', 'REFUND', 'refund_only', null], // D3-03, D3-05
    ['RETURN_OR_REFUND_REQUEST_COMPLETE', 'REFUND', 'refund_only', null],
    ['RETURN_OR_REFUND_REQUEST_CANCEL', 'RETURN_AND_REFUND', 'closed', 'buyer_cancelled'], // D3-09, D3-10
    ['RETURN_OR_REFUND_REQUEST_CANCEL', 'REFUND', 'closed', 'buyer_cancelled'],
    ['AWAITING_BUYER_SHIP', 'REFUND', null, null],
    ['TRẠNG_THÁI_MỚI', 'RETURN_AND_REFUND', null, null],
  ])('%s + %s → %s', (raw, type, status, closeResult) => {
    expect(tiktokReturnStatus(raw, type)).toMatchObject({ status, closeResult });
  });

  it.each(['REPLACEMENT', 'EXCHANGE'])('đổi hàng (%s): app chưa có luồng, status null', (type) => {
    expect(tiktokReturnStatus('REPLACEMENT_REQUEST_PENDING', type)).toEqual({ kind: 'replacement', status: null, closeResult: null });
  });
});

describe('tiktokCancellationStatus', () => {
  it.each([
    ['CANCELLATION_REQUEST_PENDING', 'pending'],
    ['CANCELLATION_REQUEST_SUCCESS', 'cancelled'],
    ['CANCELLATION_REQUEST_COMPLETE', 'cancelled'],
    ['CANCELLATION_REQUEST_CANCEL', 'withdrawn'],
    ['CANCELLATION_REQUEST_CANCELLED', 'withdrawn'],
    ['LẠ', null],
  ])('%s → %s', (raw, status) => {
    expect(tiktokCancellationStatus(raw)).toBe(status);
  });

  it('tên lý do huỷ: tiếng Việt theo phần lõi, tên lạ giữ nguyên', () => {
    expect(tiktokCancelReasonLabel('seller_cancel_reason_out_of_stock')).toBe('Hết hàng');
    expect(tiktokCancelReasonLabel('seller_cancel_unpaid_reason_wrong_price_uk')).toBe('Sai giá');
    expect(tiktokCancelReasonLabel('seller_cancel_paid_reason_address_not_deliver')).toBe('Không giao được tới địa chỉ người mua');
    expect(tiktokCancelReasonLabel('ly_do_moi')).toBe('ly_do_moi');
  });
});

describe('listReturns, listCancellations', () => {
  it('listReturns: lọc update_time_ge (giây, tính cả mốc), xếp update_time tăng, trang 50; chuẩn hoá phản hồi thật', async () => {
    const { adapter, calls } = fakeSan({
      'POST /return_refund/202602/returns/search': () => ok({ return_orders: [REAL_RETURN], next_page_token: '', total_count: 1 }),
    });
    const page = await adapter.listReturns!(TOKEN, new Date('2026-11-01T00:00:00.900Z'), null);
    expect(calls[0]!.query.get('page_size')).toBe('50');
    expect(calls[0]!.query.get('sort_field')).toBe('update_time');
    expect(calls[0]!.query.get('sort_order')).toBe('ASC');
    expect(calls[0]!.query.get('shop_cipher')).toBe('ROW_c');
    expect(calls[0]!.query.has('page_token')).toBe(false);
    expect(calls[0]!.body).toEqual({ update_time_ge: 1793491200 });
    expect(page.nextCursor).toBeNull();
    expect(page.items).toEqual([
      {
        externalId: '4042912638661985290',
        externalOrderId: '586932266789143562',
        rawStatus: 'RETURN_OR_REFUND_REQUEST_COMPLETE',
        kind: 'refund',
        status: 'refund_only',
        closeResult: null,
        initiator: 'buyer',
        reasonCode: 'ecom_order_to_ship_canceled_reason_better_price_RTS_RO',
        reason: 'Better price available',
        refundAmount: '61300',
        lines: [{ externalLineId: '586932266789274634', externalSkuId: '1738338453674427921', sellerSku: 'CM-TEST-MUG-TRANG', refundAmount: '61300' }],
        disputeInProgress: false,
        returnTrackingCode: null,
        respondBy: null,
        createdAt: new Date(1793634765 * 1000),
        updatedAt: new Date(1793634867 * 1000),
      },
    ]);
  });

  it('listReturns: lật page_token; trang rỗng còn token vẫn đi tiếp; token rỗng hay lặp lại là hết', async () => {
    const pages: Record<string, unknown> = {
      '': { return_orders: [REAL_RETURN], next_page_token: 'p2', total_count: 1 },
      p2: { next_page_token: 'p3', total_count: 1 },
      p3: { next_page_token: 'p3', total_count: 1 },
    };
    const { adapter, calls } = fakeSan({
      'POST /return_refund/202602/returns/search': (c) => ok(pages[c.query.get('page_token') ?? '']),
    });
    const at = new Date('2026-11-01T00:00:00Z');
    const p1 = await adapter.listReturns!(TOKEN, at, null);
    expect(p1.nextCursor).toBe('p2');
    const p2 = await adapter.listReturns!(TOKEN, at, p1.nextCursor);
    expect(p2).toEqual({ items: [], nextCursor: 'p3' });
    const p3 = await adapter.listReturns!(TOKEN, at, p2.nextCursor);
    expect(p3.nextCursor).toBeNull();
    expect(calls.map((c) => c.query.get('page_token'))).toEqual([null, 'p2', 'p3']);
  });

  it('listReturns: tranh chấp đang phân xử, mã vận đơn chiều về, hạn trả lời là deadline sớm nhất', async () => {
    const { adapter } = fakeSan({
      'POST /return_refund/202602/returns/search': () =>
        ok({
          return_orders: [
            {
              ...REAL_RETURN,
              return_type: 'RETURN_AND_REFUND',
              return_status: 'BUYER_SHIPPED_ITEM',
              arbitration_status: 'IN_PROGRESS',
              return_tracking_number: 'VN123',
              role: 'OPERATOR',
              seller_next_action_response: [
                { action: 'SELLER_RESPOND_RECEIVE_PACKAGE', deadline: 1793800000 },
                { action: 'SELLER_RESPOND_RETURN', deadline: 1793700000 },
              ],
            },
          ],
          next_page_token: '',
        }),
    });
    const [r] = (await adapter.listReturns!(TOKEN, new Date(0), null)).items;
    expect(r).toMatchObject({
      kind: 'return',
      status: 'awaiting_return',
      initiator: 'platform',
      disputeInProgress: true,
      returnTrackingCode: 'VN123',
      respondBy: new Date(1793700000 * 1000),
    });
  });

  it('listCancellations: khách xin huỷ đang chờ người bán; người bán, sàn huỷ thẳng', async () => {
    const { adapter, calls } = fakeSan({
      'POST /return_refund/202602/cancellations/search': () =>
        ok({
          cancellations: [
            pendingBuyerCancel,
            { ...pendingBuyerCancel, cancel_id: '2', cancel_type: 'CANCEL', cancel_status: 'CANCELLATION_REQUEST_COMPLETE', role: 'SYSTEM', seller_next_action_response: undefined },
          ],
          next_page_token: '',
          total_count: 2,
        }),
    });
    const page = await adapter.listCancellations!(TOKEN, new Date(1793600000 * 1000), null);
    expect(calls[0]!.body).toEqual({ update_time_ge: 1793600000 });
    expect(page.items[0]).toMatchObject({
      externalId: '4035318504086604100',
      externalOrderId: ORDER,
      buyerRequest: true,
      status: 'pending',
      initiator: 'buyer',
      reason: 'Order created by mistake',
      refundAmount: '61300',
      respondBy: new Date(1793772800 * 1000),
      lines: [{ externalLineId: '586945714962465802', externalSkuId: '9', sellerSku: 'A', refundAmount: null }],
    });
    expect(page.items[1]).toMatchObject({ externalId: '2', buyerRequest: false, status: 'cancelled', initiator: 'platform', respondBy: null });
  });
});

const ELIGIBILITY = `GET /return_refund/202602/orders/${ORDER}/aftersale_eligibility`;
const eligible = (lines: string[], reasons: string[]) => ({ request_type: 'CANCEL', eligible: true, order_line_items_ids: lines, available_reason_names: reasons });

describe('cancelReasons, cancelOrder', () => {
  it('cancelReasons: hỏi người bán + CANCEL; lý do chung của các món, bỏ trùng, kèm tên tiếng Việt', async () => {
    const { adapter, calls } = fakeSan({
      [ELIGIBILITY]: () =>
        ok({
          sku_eligibility: [
            { sku_id: '1', line_item_eligibility: [eligible(['L1'], ['seller_cancel_reason_out_of_stock', 'seller_cancel_reason_out_of_stock', 'seller_cancel_reason_wrong_price'])] },
            { sku_id: '2', line_item_eligibility: [eligible(['L2'], ['seller_cancel_reason_out_of_stock'])] },
          ],
        }),
    });
    expect(await adapter.cancelReasons!(TOKEN, ORDER, ['L1', 'L2'])).toEqual([{ id: 'seller_cancel_reason_out_of_stock', label: 'Hết hàng' }]);
    expect(calls[0]!.query.get('initiate_aftersale_user')).toBe('SELLER');
    expect(calls[0]!.query.get('request_types')).toBe('CANCEL');
  });

  it('cancelReasons: sàn chặn món được hỏi → rejected kèm mã, câu của sàn (gọi thật 07/11/2026)', async () => {
    const { adapter } = fakeSan({
      [ELIGIBILITY]: () =>
        ok({
          sku_eligibility: [
            {
              sku_id: '1',
              line_item_eligibility: [
                { request_type: 'CANCEL', eligible: false, ineligible_code: 25011050, ineligible_reason: "seller can't cancel non-cod order after shipped", order_line_items_ids: ['L1'] },
                { request_type: 'REFUND', eligible: true, order_line_items_ids: ['L1'], available_reason_names: ['x'] },
              ],
            },
          ],
        }),
    });
    await expect(adapter.cancelReasons!(TOKEN, ORDER, ['L1'])).rejects.toMatchObject({
      kind: 'rejected',
      platformCode: '25011050',
      platformMessage: "seller can't cancel non-cod order after shipped",
    });
  });

  it('cancelReasons: không có lý do nào → rejected not_cancellable', async () => {
    const { adapter } = fakeSan({ [ELIGIBILITY]: () => ok({ sku_eligibility: [] }) });
    await expect(adapter.cancelReasons!(TOKEN, ORDER, [])).rejects.toMatchObject({ kind: 'rejected', platformCode: 'not_cancellable' });
  });

  it('cancelOrder: huỷ cả đơn bằng Cancel Order 202602 (order_id, cancel_reason)', async () => {
    const { adapter, calls } = fakeSan({
      [ELIGIBILITY]: () => ok({ sku_eligibility: [{ line_item_eligibility: [eligible(['L1', 'L2'], ['seller_cancel_reason_out_of_stock'])] }] }),
      'POST /return_refund/202602/cancellations': () => ok({ cancel_id: '9', cancel_status: 'CANCELLATION_REQUEST_SUCCESS' }),
    });
    await adapter.cancelOrder!(TOKEN, ORDER, ['L1', 'L2'], 'seller_cancel_reason_out_of_stock');
    expect(calls[1]).toMatchObject({ method: 'POST', path: '/return_refund/202602/cancellations' });
    expect(calls[1]!.body).toEqual({ order_id: ORDER, cancel_reason: 'seller_cancel_reason_out_of_stock' });
  });

  it('cancelOrder: chỉ một phần món → partial_cancel_unsupported, không gọi huỷ', async () => {
    const { adapter, calls } = fakeSan({
      [ELIGIBILITY]: () => ok({ sku_eligibility: [{ line_item_eligibility: [eligible(['L1'], ['r']), eligible(['L2'], ['r'])] }] }),
    });
    await expect(adapter.cancelOrder!(TOKEN, ORDER, ['L1'], 'r')).rejects.toMatchObject({ kind: 'rejected', platformCode: 'partial_cancel_unsupported' });
    expect(calls).toHaveLength(1);
  });

  it('cancelOrder: lý do không có trong danh sách → cancel_reason_invalid; sàn từ chối huỷ → rejected giữ mã', async () => {
    const elig = () => ok({ sku_eligibility: [{ line_item_eligibility: [eligible(['L1'], ['r'])] }] });
    const a = fakeSan({ [ELIGIBILITY]: elig });
    await expect(a.adapter.cancelOrder!(TOKEN, ORDER, ['L1'], 'khac')).rejects.toMatchObject({ platformCode: 'cancel_reason_invalid' });
    const b = fakeSan({
      [ELIGIBILITY]: elig,
      'POST /return_refund/202602/cancellations': () => json({ code: 25001011, message: 'A return request is already in process, or the order has already been cancelled.' }),
    });
    await expect(b.adapter.cancelOrder!(TOKEN, ORDER, ['L1'], 'r')).rejects.toMatchObject({ kind: 'rejected', platformCode: '25001011' });
  });
});

describe('decideCancelRequest, cancelRequestRejectReasons', () => {
  const search = 'POST /return_refund/202602/cancellations/search';

  it('đồng ý: tìm lần huỷ khách đang chờ của đơn rồi approve, không body, có idempotency_key', async () => {
    const { adapter, calls } = fakeSan({
      [search]: () => ok({ cancellations: [pendingBuyerCancel], next_page_token: '' }),
      'POST /return_refund/202309/cancellations/4035318504086604100/approve': () => ok({}),
    });
    await adapter.decideCancelRequest!(TOKEN, ORDER, true);
    expect(calls[0]!.body).toEqual({ order_ids: [ORDER], cancel_types: ['BUYER_CANCEL'], cancel_status: ['CANCELLATION_REQUEST_PENDING'] });
    expect(calls[1]!.path).toBe('/return_refund/202309/cancellations/4035318504086604100/approve');
    expect(calls[1]!.body).toBeUndefined();
    expect(calls[1]!.query.get('idempotency_key')).toBe('commerio-4035318504086604100-approve');
  });

  it('từ chối: gửi reject_reason; thiếu lý do thì reject_reason_required, không gọi sàn', async () => {
    const { adapter, calls } = fakeSan({
      [search]: () => ok({ cancellations: [pendingBuyerCancel] }),
      'POST /return_refund/202309/cancellations/4035318504086604100/reject': () => ok({}),
    });
    await expect(adapter.decideCancelRequest!(TOKEN, ORDER, false)).rejects.toMatchObject({ kind: 'rejected', platformCode: 'reject_reason_required' });
    expect(calls).toHaveLength(0);
    await adapter.decideCancelRequest!(TOKEN, ORDER, false, 'seller_reject_apply_product_has_been_packed');
    expect(calls[1]!.body).toEqual({ reject_reason: 'seller_reject_apply_product_has_been_packed' });
  });

  it('không còn yêu cầu huỷ đang chờ → cancel_request_not_found', async () => {
    const { adapter } = fakeSan({
      [search]: () => ok({ cancellations: [{ ...pendingBuyerCancel, cancel_status: 'CANCELLATION_REQUEST_CANCELLED' }] }),
    });
    await expect(adapter.decideCancelRequest!(TOKEN, ORDER, true)).rejects.toMatchObject({ platformCode: 'cancel_request_not_found' });
  });

  it('cancelRequestRejectReasons: Get Decision Eligibility 202601 cho REJECT_REQUEST_CANCEL', async () => {
    const { adapter, calls } = fakeSan({
      [search]: () => ok({ cancellations: [pendingBuyerCancel] }),
      'GET /return_refund/202601/decision_eligibility': () =>
        ok({
          decisions: [
            {
              decision: 'REJECT_REQUEST_CANCEL',
              eligible: true,
              available_reject_reasons: [{ name: 'seller_reject_apply_product_has_been_packed', text: 'Sản phẩm đã được đóng gói' }],
            },
          ],
        }),
    });
    expect(await adapter.cancelRequestRejectReasons!(TOKEN, ORDER)).toEqual([
      { id: 'seller_reject_apply_product_has_been_packed', label: 'Sản phẩm đã được đóng gói' },
    ]);
    expect(calls[1]!.query.get('return_or_cancel_id')).toBe('4035318504086604100');
    expect(calls[1]!.query.get('check_decisions')).toBe('REJECT_REQUEST_CANCEL');
  });

  it('cancelRequestRejectReasons: sàn không cho từ chối → rejected kèm câu của sàn', async () => {
    const { adapter } = fakeSan({
      [search]: () => ok({ cancellations: [pendingBuyerCancel] }),
      'GET /return_refund/202601/decision_eligibility': () =>
        ok({ decisions: [{ decision: 'REJECT_REQUEST_CANCEL', eligible: false, ineligible_code: 25011011, ineligible_reason: 'reverse status cannot reject application' }] }),
    });
    await expect(adapter.cancelRequestRejectReasons!(TOKEN, ORDER)).rejects.toMatchObject({
      kind: 'rejected',
      platformCode: '25011011',
      platformMessage: 'reverse status cannot reject application',
    });
  });
});
