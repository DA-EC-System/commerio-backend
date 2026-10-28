import { describe, expect, it } from 'vitest';
import { assertTransition, availableActions } from '#src/modules/core/index.ts';
import {
  type PurchaseRequestRecord,
  type PurchaseRequestStatus,
  purchaseRequestMachine,
} from '#src/modules/product/purchasing/domain/request-machine.ts';

const buyer = { accountId: 'buyer', permissions: ['purchasing.request.manage'], enabledModules: ['purchasing'] };
const ceo = {
  accountId: 'ceo',
  permissions: ['purchasing.request.manage', 'purchasing.request.approve'],
  enabledModules: ['purchasing'],
};
const record = (r: Partial<PurchaseRequestRecord> = {}): PurchaseRequestRecord => ({
  createdBy: 'buyer',
  lineCount: 2,
  activeLines: 2,
  receiptCount: 0,
  countingReceipts: 0,
  ...r,
});
const to = (from: PurchaseRequestStatus, action: Parameters<typeof assertTransition>[2], actor = ceo, r = record(), reason?: string) =>
  assertTransition(purchaseRequestMachine, from, action as never, { actor, record: r, reason: reason ?? null }).to;

describe('máy trạng thái đề nghị nhập', () => {
  it('đi trọn luồng nháp → chờ duyệt → đã duyệt → đã đặt', () => {
    expect(to('draft', 'submit', buyer)).toBe('pending_approval');
    expect(to('pending_approval', 'approve')).toBe('approved');
    expect(to('approved', 'order', buyer)).toBe('ordered');
  });

  it('rút lại về nháp; trả về rồi gửi lại', () => {
    expect(to('pending_approval', 'withdraw', buyer)).toBe('draft');
    expect(to('pending_approval', 'request_changes', ceo, record(), 'Giá cao')).toBe('changes_requested');
    expect(to('changes_requested', 'resubmit', buyer)).toBe('pending_approval');
  });

  it('gửi duyệt đề nghị không có dòng bị chặn bằng empty_document', () => {
    expect(() => to('draft', 'submit', buyer, record({ lineCount: 0, activeLines: 0 }))).toThrow(
      expect.objectContaining({ status: 409, code: 'empty_document' }),
    );
  });

  it('người lập duyệt chính đề nghị của mình: 409 second_person_required, trừ khi được tự duyệt', () => {
    const own = record({ createdBy: 'ceo' });
    expect(() => to('pending_approval', 'approve', ceo, own)).toThrow(expect.objectContaining({ code: 'second_person_required' }));
    const result = assertTransition(purchaseRequestMachine, 'pending_approval', 'approve', {
      actor: ceo,
      record: own,
      canSelfApprove: true,
    });
    expect(result).toEqual({ to: 'approved', selfApproved: true });
  });

  it('duyệt khi mọi dòng đã bị loại: all_lines_excluded', () => {
    expect(() => to('pending_approval', 'approve', ceo, record({ activeLines: 0 }))).toThrow(
      expect.objectContaining({ code: 'all_lines_excluded' }),
    );
  });

  it('trả về, từ chối, đóng thiếu bắt buộc lý do', () => {
    for (const [from, action] of [
      ['pending_approval', 'request_changes'],
      ['pending_approval', 'reject'],
      ['ordered', 'close_short'],
    ] as const) {
      expect(() => to(from, action)).toThrow(expect.objectContaining({ status: 422, code: 'reason_required' }));
    }
  });

  it('mua hàng không duyệt, không đóng thiếu được (403)', () => {
    expect(() => to('pending_approval', 'approve', buyer, record({ createdBy: 'khac' }))).toThrow(
      expect.objectContaining({ status: 403, code: 'forbidden' }),
    );
    expect(() => to('ordered', 'close_short', buyer, record(), 'NCC hết hàng')).toThrow(expect.objectContaining({ code: 'forbidden' }));
  });

  it('đóng thiếu bị chặn khi còn phiếu nhận đang kiểm', () => {
    expect(() => to('partially_received', 'close_short', ceo, record({ countingReceipts: 1 }), 'NCC hết hàng')).toThrow(
      expect.objectContaining({ code: 'receipt_counting' }),
    );
    expect(to('partially_received', 'close_short', ceo, record(), 'NCC hết hàng')).toBe('closed_short');
  });

  it('huỷ: mua hàng huỷ nháp không cần lý do; đã duyệt chỉ CEO, có lý do, chưa có phiếu nhận', () => {
    expect(to('draft', 'cancel', buyer)).toBe('cancelled');
    expect(() => to('approved', 'cancel', buyer, record(), 'Đổi NCC')).toThrow(expect.objectContaining({ code: 'forbidden' }));
    expect(() => to('ordered', 'cancel', ceo)).toThrow(expect.objectContaining({ code: 'reason_required' }));
    expect(() => to('ordered', 'cancel', ceo, record({ receiptCount: 1 }), 'Đổi NCC')).toThrow(
      expect.objectContaining({ code: 'has_receipts' }),
    );
    expect(to('ordered', 'cancel', ceo, record(), 'Đổi NCC')).toBe('cancelled');
  });

  it('nhận một phần, nhận xong chỉ hệ thống chuyển', () => {
    expect(assertTransition(purchaseRequestMachine, 'ordered', 'receive_partial', { actor: null }).to).toBe('partially_received');
    expect(assertTransition(purchaseRequestMachine, 'partially_received', 'receive_all', { actor: null }).to).toBe('received');
    expect(() => to('ordered', 'receive_all')).toThrow(expect.objectContaining({ code: 'invalid_transition' }));
  });

  it('trạng thái kết thúc không còn thao tác nào', () => {
    for (const s of ['rejected', 'received', 'closed_short', 'cancelled'] as const) {
      expect(availableActions(purchaseRequestMachine, s, { actor: ceo, record: record({ createdBy: 'khac' }) })).toEqual([]);
    }
  });

  it('tắt phân hệ purchasing thì quyền không có hiệu lực', () => {
    const off = { ...ceo, enabledModules: [] };
    expect(() => to('draft', 'submit', off)).toThrow(expect.objectContaining({ code: 'forbidden' }));
  });
});
