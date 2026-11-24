// Yêu cầu trả Lazada (#202): ánh xạ đơn ngược và tham số gửi sàn, gọi qua `call` giả (không gọi mạng).
import { describe, expect, it } from 'vitest';
import {
  lazadaReturnLineStatus,
  lazadaReturnMethods,
  toLazadaReturn,
} from '#src/modules/channel/channel/service/marketplaces/lazada-returns.ts';
import { MarketplaceError } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { lazadaAmount } from '#src/modules/channel/channel/service/marketplaces/lazada.ts';

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
const toReturn = (i: object) => toLazadaReturn(i as Record<string, unknown>, lazadaAmount);
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
    ['REFUND_SUCCESS', null, 'return', 'refund_only'],
    ['REFUND_PENDING', 'INFO_ST_DRIVER_ASSIGNED', 'return', 'awaiting_return'],
    ['REQUEST_CANCEL', null, 'return', 'closed'],
    // #436: ba giá trị gặp thật mà trước đây trả null
    ['SELLER_AGREE_RETURN', null, 'return', 'awaiting_return'],
    ['SELLER_REJECT_RETURN', null, 'return', 'rejected'],
    ['BUYER_RETURN_ITEM', 'INFO_ST_DRIVER_ASSIGNED', 'return', 'awaiting_return'],
    ['BUYER_RETURN_ITEM', 'INFO_ST_RETURN_RTM_DELIVERED', 'return', 'received'],
  ] as const)('%s + %s (%s) → %s', (reverse, ofc, kind, status) => {
    expect(lazadaReturnLineStatus(reverse, ofc, kind)?.status).toBe(status);
  });

  it('khách huỷ thì kèm `buyer_cancelled`; giá trị lạ là null', () => {
    expect(lazadaReturnLineStatus('REQUEST_CANCEL', null, 'return')).toEqual({ status: 'closed', closeResult: 'buyer_cancelled' });
    expect(lazadaReturnLineStatus('SOMETHING_NEW', null, 'return')).toBeNull();
    // #436: chiều về bị huỷ sau khi khách gửi, chưa rõ ai huỷ → chưa ánh xạ
    expect(lazadaReturnLineStatus('BUYER_RETURN_ITEM', 'RETURN_CANCELED', 'return')).toBeNull();
  });
});

describe('toLazadaReturn', () => {
  it('đổi mã, món, tiền, thời điểm; trả về người bán khi `is_rtm`', () => {
    const r = toReturn(item([line(1, { tracking_number: 'JNT-1' }), line(2)]));
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
    const mixed = toReturn(item([line(1, { reverse_status: 'REFUND_SUCCESS', ofc_status: 'RETURN_CANCELED' }), line(2)]));
    expect(mixed.status).toBe('requested');
    expect(mixed.rawStatus).toBe('REFUND_SUCCESS,REQUEST_INITIATE');
    expect(toReturn(item([line(1), line(2, { reverse_status: 'LA' })])).status).toBeNull();
  });

  it('hạn trả lời là `sla` sớm nhất khi còn chờ người bán; đã đồng ý hay từ chối thì không có hạn', () => {
    const lines = [line(1, { sla: '1794200000000' }), line(2, { sla: '1794100000000' })];
    expect(toReturn(item(lines)).respondBy).toEqual(new Date(1794100000000));
    expect(toReturn(item([line(1)])).respondBy).toBeNull();
    const agreed = lines.map((l) => ({ ...l, reverse_status: 'SELLER_AGREE_RETURN' }));
    expect(toReturn(item(agreed)).respondBy).toBeNull();
  });

  it('số tiền hoàn đọc bằng `lazadaAmount` (dấu phẩy nghìn); có dòng không đọc được thì tổng null kèm chuỗi gốc, không ghi 0', () => {
    expect(toReturn(item([line(1, { refund_amount: '1,600.02' }), line(2, { refund_amount: '400' })]))).toMatchObject({
      refundAmount: '2000.02',
      refundAmountUnreadable: null,
    });
    expect(toReturn(item([line(1, { refund_amount: 32000 })])).lines[0]!.refundAmount).toBe('32000');
    expect(toReturn(item([line(1, { refund_amount: null })]))).toMatchObject({ refundAmount: null, refundAmountUnreadable: null });
    // Hậu tố " VND" (payout staging, #349): bộ đọc trên main chưa nhận nên coi là không đọc được; #349 nhận thì đọc ra số.
    for (const raw of ['0.00 VND', '1,600.02 VND']) {
      const r = toReturn(item([line(1, { refund_amount: raw }), line(2, { refund_amount: '400' })]));
      expect(r).toMatchObject({ refundAmount: null, refundAmountUnreadable: raw });
      expect(r.lines.map((l) => l.refundAmount)).toEqual([null, '400']);
    }
  });

  it('sàn xác nhận hoàn tiền (#437) khi mọi món REFUND_PENDING/REFUND_SUCCESS và hàng đã về người bán', () => {
    const atSeller = { ofc_status: 'INFO_ST_RETURN_RTM_DELIVERED' };
    expect(toReturn(item([line(1, { reverse_status: 'REFUND_PENDING', ...atSeller }), line(2, { reverse_status: 'REFUND_SUCCESS', ...atSeller })])).refundConfirmed).toBe(true);
    // Một món chưa quyết hoàn tiền, hàng còn đang về (`instantRefund`), hay chỉ hoàn tiền: chưa phải.
    expect(toReturn(item([line(1, { reverse_status: 'REFUND_PENDING', ...atSeller }), line(2, { reverse_status: 'BUYER_RETURN_ITEM', ...atSeller })])).refundConfirmed).toBe(false);
    expect(toReturn(item([line(1, { reverse_status: 'REFUND_PENDING', ofc_status: 'INFO_ST_DRIVER_ASSIGNED' })])).refundConfirmed).toBe(false);
    expect(toReturn(item([line(1, { reverse_status: 'REFUND_SUCCESS', ...atSeller })], { request_type: 'ONLY_REFUND' })).refundConfirmed).toBe(false);
  });

  it('`ONLY_REFUND` là chỉ hoàn tiền; `return_to_type` RTW là kho sàn', () => {
    expect(toReturn(item([line(1)], { request_type: 'ONLY_REFUND' })).kind).toBe('refund');
    expect(toReturn(item([line(1)], { return_to_type: 'RTW' })).returnTo).toBe('warehouse');
  });
});

function fakeCall(responses: Record<string, unknown>) {
  const calls: [string, Record<string, string>][] = [];
  const call = async (path: string, params: Record<string, string>) => {
    calls.push([path, params]);
    const res = responses[path];
    if (res instanceof Error) throw res;
    return (res ?? { code: '0' }) as Record<string, unknown>;
  };
  return { calls, methods: lazadaReturnMethods(call, lazadaAmount) };
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

  it('đơn ngược không có dòng thì bỏ qua (không tạo mốc thời gian sai)', async () => {
    const { methods } = fakeCall({
      '/reverse/getreverseordersforseller': { result: { items: [item([], { reverse_order_id: 1 }), item([line(1)])] } },
    });
    const page = await methods.listReturns('tok', new Date(), null);
    expect(page.items.map((i) => i.externalId)).toEqual(['7000']);
    expect(page.items.every((i) => !Number.isNaN(i.updatedAt.getTime()))).toBe(true);
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

  it('chỉ hoàn tiền (ONLY_REFUND) đi ReverseOrderOnlyRefundDecide từng dòng: hoàn là agreeRefund, từ chối là startDispute kèm comment', async () => {
    const { calls, methods } = fakeCall({});
    await methods.decideReturn('tok', '7000', ['7001', '7002'], 'refund', { kind: 'refund' });
    await methods.decideReturn('tok', '7000', ['7001'], 'reject', { kind: 'refund', reasonId: '100000046', comment: 'Hàng còn nguyên' });
    expect(calls.map(([p, q]) => [p, q.action, q.reverse_order_item_ids, q.comment ?? null])).toEqual([
      ['/order/reverse/onlyrefund/seller/decide', 'agreeRefund', '[7001]', null],
      ['/order/reverse/onlyrefund/seller/decide', 'agreeRefund', '[7002]', null],
      ['/order/reverse/onlyrefund/seller/decide', 'startDispute', '[7001]', 'Hàng còn nguyên'],
    ]);
    await expect(methods.decideReturn('tok', '7000', ['7001'], 'accept', { kind: 'refund' })).rejects.toMatchObject({ platformCode: 'refund_only_request' });
  });

  it('ảnh minh chứng (#437): refuseReturn gửi `image_info` [{name,url}], startDispute gửi `image_info_list` [{file_url,file_name}] theo mẫu tài liệu', async () => {
    const images = [
      { name: 'vet-xuoc.jpg', url: 'https://vn-live.slatic.net/p/a.jpg' },
      { name: 'hop.png', url: 'https://vn-live.slatic.net/p/b.png' },
    ];
    const { calls, methods } = fakeCall({});
    await methods.decideReturn('tok', '7000', ['7001'], 'reject', { reasonId: '100000046', images });
    await methods.decideReturn('tok', '7000', ['7001'], 'reject', { kind: 'refund', comment: 'Hàng còn nguyên', images });
    await methods.decideReturn('tok', '7000', ['7001'], 'reject', { reasonId: '100000046' });
    expect(JSON.parse(calls[0]![1].image_info!)).toEqual(images);
    expect(calls[0]![1].image_info_list).toBeUndefined();
    expect(JSON.parse(calls[1]![1].image_info_list!)).toEqual([
      { file_url: 'https://vn-live.slatic.net/p/a.jpg', file_name: 'vet-xuoc.jpg' },
      { file_url: 'https://vn-live.slatic.net/p/b.png', file_name: 'hop.png' },
    ]);
    expect(calls[1]![1].image_info).toBeUndefined();
    expect('image_info' in calls[2]![1]).toBe(false);
  });

  it('hoàn tiền là instantRefund, báo đã nhận là confirmDelivery', async () => {
    const { calls, methods } = fakeCall({});
    await methods.decideReturn('tok', '7000', ['7001'], 'refund', {});
    await methods.confirmReturnReceived('tok', '7000', ['7001']);
    expect(calls.map(([, q]) => q.action)).toEqual(['instantRefund', 'confirmDelivery']);
  });

  it('lý do tra theo dòng đầu của yêu cầu; từ chối trả hàng và từ chối hoàn tiền đều đòi ảnh (#437, LZ-TRA-U06)', async () => {
    const { calls, methods } = fakeCall({
      '/reverse/getreverseordersforseller': { result: { items: [item([line(1)])] } },
      '/order/reverse/reason/list': { data: [{ reason_id: 100000046, muti_language_text: 'Sản phẩm bình thường', text: 'not as claimed' }] },
    });
    expect(await methods.returnReasons('tok', '7000', 'reject')).toEqual([{ id: '100000046', label: 'Sản phẩm bình thường', requiresImage: true }]);
    expect(calls[1]).toEqual(['/order/reverse/reason/list', { access_token: 'tok', reverse_order_line_id: '7001' }]);
    expect((await methods.returnReasons('tok', '7000', 'refuse-refund'))[0]!.requiresImage).toBe(true);
  });

  it('đồng ý hoàn tiền sau kiểm hàng (#437) là agreeRefund mọi dòng của yêu cầu', async () => {
    const { calls, methods } = fakeCall({});
    await methods.approveReturnRefund('tok', '7000', ['7001', '7002']);
    expect(calls).toEqual([
      ['/order/reverse/return/update', { access_token: 'tok', action: 'agreeRefund', reverse_order_id: '7000', reverse_order_item_ids: '[7001,7002]' }],
    ]);
    await expect(methods.approveReturnRefund('tok', '7000', [])).rejects.toMatchObject({ platformCode: 'return_lines_missing' });
  });

  it('agreeRefund bị từ chối mà đơn ngược đã qua bước hoàn tiền (làm trên Seller Center) thì coi là xong', async () => {
    const { methods } = fakeCall({
      '/order/reverse/return/update': new MarketplaceError('rejected', '114', 'E0114: this reverse does not support this action'),
      '/reverse/getreverseordersforseller': { result: { items: [item([line(1, { reverse_status: 'REFUND_PENDING' }), line(2, { reverse_status: 'REFUND_SUCCESS' })])] } },
    });
    await expect(methods.approveReturnRefund('tok', '7000', ['7001', '7002'])).resolves.toBeUndefined();
  });

  it.each(['REFUND_REJECT', 'REQUEST_CANCEL', 'CANCEL_SUCCESS'])('agreeRefund bị từ chối mà dòng đã %s trên sàn thì báo lỗi kèm câu cho người dùng, không coi là xong', async (status) => {
    const { methods } = fakeCall({
      '/order/reverse/return/update': new MarketplaceError('rejected', '114', 'E0114: this reverse does not support this action'),
      '/reverse/getreverseordersforseller': { result: { items: [item([line(1, { reverse_status: 'REFUND_PENDING' }), line(2, { reverse_status: status })])] } },
    });
    await expect(methods.approveReturnRefund('tok', '7000', ['7001', '7002'])).rejects.toMatchObject({
      kind: 'rejected',
      userMessage: 'Lazada đã từ chối hoặc huỷ hoàn tiền yêu cầu này, kiểm trên Seller Center',
    });
  });

  it('agreeRefund bị từ chối mà đơn ngược chưa qua bước hoàn tiền thì ném lỗi; lỗi tạm không đọc lại', async () => {
    const { methods } = fakeCall({
      '/order/reverse/return/update': new MarketplaceError('rejected', '113', 'E0113: reverse order line have unknown status'),
      '/reverse/getreverseordersforseller': { result: { items: [item([line(1, { reverse_status: 'BUYER_RETURN_ITEM' })])] } },
    });
    await expect(methods.approveReturnRefund('tok', '7000', ['7001'])).rejects.toMatchObject({ kind: 'rejected', platformCode: '113' });
    const busy = fakeCall({ '/order/reverse/return/update': new MarketplaceError('unavailable', '6', 'Unexpected internal error') });
    await expect(busy.methods.approveReturnRefund('tok', '7000', ['7001'])).rejects.toMatchObject({ kind: 'unavailable' });
    expect(busy.calls).toHaveLength(1);
  });

  it('mã 6 khi từ chối là sàn không nhận lệnh, không bảo thử lại (LZ-TRA-U05); mã 6 của lệnh khác vẫn là lỗi tạm', async () => {
    const six = () => new MarketplaceError('unavailable', '6', 'Unexpected internal error');
    const noImage = fakeCall({ '/order/reverse/return/update': six() });
    await expect(noImage.methods.decideReturn('tok', '7000', ['7001'], 'reject', { reasonId: '100000046' })).rejects.toMatchObject({
      kind: 'rejected',
      platformCode: '6',
      userMessage: 'Lazada không nhận lệnh từ chối, cần ít nhất 1 ảnh bằng chứng',
    });
    const withImage = fakeCall({ '/order/reverse/return/update': six() });
    const images = [{ name: 'a.jpg', url: 'https://vn-live.slatic.net/p/a.jpg' }];
    await expect(withImage.methods.decideReturn('tok', '7000', ['7001'], 'reject', { reasonId: '100000046', images })).rejects.toMatchObject({
      kind: 'rejected',
      userMessage: expect.stringContaining('Seller Center'),
    });
    const confirm = fakeCall({ '/order/reverse/return/update': six() });
    await expect(confirm.methods.confirmReturnReceived('tok', '7000', ['7001'])).rejects.toMatchObject({ kind: 'unavailable', userMessage: null });
  });

  it('E0114 báo yêu cầu đã được xử lý trên Lazada', async () => {
    const { methods } = fakeCall({ '/order/reverse/return/update': new MarketplaceError('rejected', '114', 'E0114: this reverse does not support this action') });
    await expect(methods.decideReturn('tok', '7000', ['7001', '7002'], 'accept', {})).rejects.toMatchObject({
      kind: 'rejected',
      platformCode: '114',
      userMessage: 'Yêu cầu này đã được xử lý trên Lazada. Tải lại để xem trạng thái mới',
    });
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
