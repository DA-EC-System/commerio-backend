// Yêu cầu trả Lazada (#202): ánh xạ đơn ngược và tham số gửi sàn, gọi qua `call` giả (không gọi mạng).
import { describe, expect, it } from 'vitest';
import {
  lazadaReturnLineStatus,
  lazadaReturnMethods,
  toLazadaReturn,
} from '#src/modules/channel/channel/service/marketplaces/lazada-returns.ts';

/** Dạng một phần tử `result.items` gặp khi gọi thật 12/11/2026 (số liệu giả). */
const line = (n: number, patch: Record<string, unknown> = {}) => ({
  reverse_order_line_id: 7000 + n,
  trade_order_line_id: 5000 + n,
  reverse_status: 'REQUEST_INITIATE',
  seller_sku_id: 'AO-01',
  platform_sku_id: '1_VNAMZ-1',
  refund_amount: 32000,
  item_unit_price: 32000,
  reason_text: 'Hàng lỗi',
  reason_code: 120000003,
  is_dispute: false,
  return_order_line_gmt_create: 1794195270,
  return_order_line_gmt_modified: 1794195270 + n,
  ...patch,
});
const item = (lines: object[], patch: Record<string, unknown> = {}) => ({
  reverse_order_id: 7000,
  request_type: 'RETURN',
  is_rtm: true,
  trade_order_id: 5000,
  reverse_order_lines: lines,
  ...patch,
});

describe('lazadaReturnLineStatus', () => {
  it.each([
    ['REQUEST_INITIATE', null, 'return', 'requested'],
    ['REQUEST_REJECT', null, 'return', 'rejected'],
    ['REFUND_REJECT', 'RETURN_CANCELED', 'return', 'rejected'],
    ['REQUEST_CANCEL', 'RETURN_CANCELED', 'return', 'closed'],
    ['REFUND_PENDING', null, 'return', 'awaiting_return'],
    ['REFUND_PENDING', 'INFO_ST_RETURN_RTM_DELIVERED', 'return', 'received'],
    ['REFUND_PENDING', null, 'refund', 'requested'],
    ['REFUND_SUCCESS', 'RETURN_CANCELED', 'return', 'refund_only'],
    ['REFUND_SUCCESS', 'INFO_ST_RETURN_RTM_DELIVERED', 'return', 'received'],
  ] as const)('%s + %s (%s) → %s', (reverse, ofc, kind, status) => {
    expect(lazadaReturnLineStatus(reverse, ofc, kind)?.status).toBe(status);
  });

  it('khách huỷ thì kèm `buyer_cancelled`; giá trị lạ là null', () => {
    expect(lazadaReturnLineStatus('REQUEST_CANCEL', null, 'return')).toEqual({ status: 'closed', closeResult: 'buyer_cancelled' });
    expect(lazadaReturnLineStatus('SOMETHING_NEW', null, 'return')).toBeNull();
  });
});

describe('toLazadaReturn', () => {
  it('đổi mã, món, tiền, thời điểm; trả về người bán khi `is_rtm`', () => {
    const r = toLazadaReturn(item([line(1, { tracking_number: 'JNT-1' }), line(2)]));
    expect(r).toMatchObject({
      externalId: '7000',
      externalOrderId: '5000',
      kind: 'return',
      status: 'requested',
      rawStatus: 'REQUEST_INITIATE',
      ofcStatus: null,
      reason: 'Hàng lỗi',
      refundAmount: '64000',
      returnTrackingCode: 'JNT-1',
      returnTo: 'merchant',
      disputeInProgress: false,
    });
    expect(r.lines.map((l) => [l.externalLineId, l.externalReturnLineId, l.quantity])).toEqual([
      ['5001', '7001', 1],
      ['5002', '7002', 1],
    ]);
    expect(r.updatedAt).toEqual(new Date((1794195270 + 2) * 1000));
  });

  it('món lệch trạng thái lấy món còn phải làm; có món trạng thái lạ thì không đổi trạng thái', () => {
    const mixed = toLazadaReturn(item([line(1, { reverse_status: 'REFUND_SUCCESS', ofc_status: 'RETURN_CANCELED' }), line(2)]));
    expect(mixed.status).toBe('requested');
    expect(mixed.rawStatus).toBe('REFUND_SUCCESS,REQUEST_INITIATE');
    expect(toLazadaReturn(item([line(1), line(2, { reverse_status: 'LA' })])).status).toBeNull();
  });

  it('`ONLY_REFUND` là chỉ hoàn tiền; `return_to_type` RTW là kho sàn', () => {
    expect(toLazadaReturn(item([line(1)], { request_type: 'ONLY_REFUND' })).kind).toBe('refund');
    expect(toLazadaReturn(item([line(1)], { return_to_type: 'RTW' })).returnTo).toBe('warehouse');
  });
});

function fakeCall(responses: Record<string, unknown>) {
  const calls: [string, Record<string, string>][] = [];
  const call = async (path: string, params: Record<string, string>) => {
    calls.push([path, params]);
    return (responses[path] ?? { code: '0' }) as Record<string, unknown>;
  };
  return { calls, methods: lazadaReturnMethods(call) };
}

describe('lazadaReturnMethods', () => {
  it('listReturns lọc theo giờ sửa (ms), bỏ đơn ngược loại CANCEL, hết trang khi ít hơn 100', async () => {
    const { calls, methods } = fakeCall({
      '/reverse/getreverseordersforseller': { result: { items: [item([line(1)]), item([line(1)], { reverse_order_id: 1, request_type: 'CANCEL' })] } },
    });
    const since = new Date('2026-11-01T00:00:00Z');
    const page = await methods.listReturns('tok', since, null);
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((i) => i.externalId)).toEqual(['7000']);
    expect(calls[0]![1]).toMatchObject({ page_no: '1', page_size: '100', ReverseOrderLineModifiedTimeRangeStart: String(since.getTime()) });
  });

  it('từ chối gửi từng dòng kèm lý do và comment; đồng ý gửi cả danh sách dòng', async () => {
    const { calls, methods } = fakeCall({});
    await methods.decideReturn('tok', '7000', ['7001', '7002'], 'reject', { reasonId: '100000046' });
    await methods.decideReturn('tok', '7000', ['7001', '7002'], 'accept', {});
    expect(calls.map(([p, q]) => [p, q.action, q.reverse_order_item_ids, q.reason_id ?? null, Boolean(q.comment)])).toEqual([
      ['/order/reverse/return/update', 'refuseReturn', '[7001]', '100000046', true],
      ['/order/reverse/return/update', 'refuseReturn', '[7002]', '100000046', true],
      ['/order/reverse/return/update', 'agreeReturn', '[7001,7002]', null, false],
    ]);
    await expect(methods.decideReturn('tok', '7000', ['7001'], 'reject', {})).rejects.toMatchObject({ kind: 'rejected', platformCode: 'reject_reason_required' });
  });

  it('hoàn tiền là instantRefund, báo đã nhận là confirmDelivery', async () => {
    const { calls, methods } = fakeCall({});
    await methods.decideReturn('tok', '7000', ['7001'], 'refund', {});
    await methods.confirmReturnReceived('tok', '7000', ['7001']);
    expect(calls.map(([, q]) => q.action)).toEqual(['instantRefund', 'confirmDelivery']);
  });

  it('lý do tra theo dòng đầu của yêu cầu; từ chối hoàn tiền đòi ảnh', async () => {
    const { calls, methods } = fakeCall({
      '/reverse/getreverseordersforseller': { result: { items: [item([line(1)])] } },
      '/order/reverse/reason/list': { data: [{ reason_id: 100000046, muti_language_text: 'Sản phẩm bình thường', text: 'not as claimed' }] },
    });
    expect(await methods.returnReasons('tok', '7000', 'reject')).toEqual([{ id: '100000046', label: 'Sản phẩm bình thường', requiresImage: false }]);
    expect(calls[1]).toEqual(['/order/reverse/reason/list', { access_token: 'tok', reverse_order_line_id: '7001' }]);
    expect((await methods.returnReasons('tok', '7000', 'refuse-refund'))[0]!.requiresImage).toBe(true);
  });

  it('lịch sử mới nhất trước, ghi người thao tác và số ảnh', async () => {
    const { methods } = fakeCall({
      '/order/reverse/return/history/list': {
        data: { list: [{ time: 1794195270870, operator: 'Customer Test', picture: ['a', 'b'] }, { time: 1794368693765, operator: 'Timeout' }] },
      },
    });
    const items = await methods.returnHistory('tok', '7000', ['7001']);
    expect(items.map((i) => [i.at.getTime(), i.note])).toEqual([
      [1794368693765, 'Timeout'],
      [1794195270870, 'Customer Test · 2 ảnh'],
    ]);
  });
});
