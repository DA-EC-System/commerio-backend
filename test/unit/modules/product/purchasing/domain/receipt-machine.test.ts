import { describe, expect, it } from 'vitest';
import { assertTransition } from '#src/modules/core/index.ts';
import {
  type GoodsReceiptAction,
  goodsReceiptMachine,
  type GoodsReceiptRecord,
  type GoodsReceiptStatus,
} from '#src/modules/product/purchasing/domain/receipt-machine.ts';

const kho = { accountId: 'kho', permissions: ['purchasing.receipt.manage'], enabledModules: ['purchasing'] };
const buyer = { accountId: 'buyer', permissions: ['purchasing.request.manage'], enabledModules: ['purchasing'] };
const rec = (r: Partial<GoodsReceiptRecord> = {}): GoodsReceiptRecord => ({ createdBy: 'buyer', short: 0, ...r });
const to = (from: GoodsReceiptStatus, action: GoodsReceiptAction, actor = kho, r = rec(), reason?: string) =>
  assertTransition(goodsReceiptMachine, from, action, { actor, record: r, reason: reason ?? null }).to;

// Bảng chuyển của phiếu nhận (Documents/21 mục 16.3, spec #109 mục 6.4).
describe('máy trạng thái phiếu nhận', () => {
  it('ghi sổ không thiếu → matched; có thiếu thì post bị has_shortage, post_short → short', () => {
    expect(to('counting', 'post')).toBe('matched');
    expect(() => to('counting', 'post', kho, rec({ short: 3 }))).toThrow(expect.objectContaining({ status: 409, code: 'has_shortage' }));
    expect(to('counting', 'post_short', kho, rec({ short: 3 }))).toBe('short');
  });

  it('post_short khi không thiếu → 409 no_shortage', () => {
    expect(() => to('counting', 'post_short')).toThrow(expect.objectContaining({ status: 409, code: 'no_shortage' }));
  });

  it('người lập đề nghị ghi sổ: second_person_required; được tự duyệt thì qua và đánh dấu selfApproved', () => {
    const own = rec({ createdBy: 'kho' });
    expect(() => to('counting', 'post', kho, own)).toThrow(expect.objectContaining({ code: 'second_person_required' }));
    expect(assertTransition(goodsReceiptMachine, 'counting', 'post', { actor: kho, record: own, canSelfApprove: true })).toEqual({
      to: 'matched',
      selfApproved: true,
    });
  });

  it('huỷ phiếu không có lý do → 422 reason_required', () => {
    expect(() => to('counting', 'cancel')).toThrow(expect.objectContaining({ status: 422, code: 'reason_required' }));
    expect(to('counting', 'cancel', kho, rec(), 'NCC giao nhầm đơn')).toBe('cancelled');
  });

  it('ghi kết quả giao thiếu cần purchasing.request.manage: kho bị 403, mua hàng đi short → resolved', () => {
    expect(() => to('short', 'resolve')).toThrow(expect.objectContaining({ status: 403, code: 'forbidden' }));
    expect(to('short', 'resolve', buyer)).toBe('resolved');
  });

  it('auto_resolve chỉ hệ thống làm', () => {
    expect(assertTransition(goodsReceiptMachine, 'short', 'auto_resolve', { actor: null }).to).toBe('resolved');
    expect(() => to('short', 'auto_resolve', buyer)).toThrow(expect.objectContaining({ code: 'invalid_transition' }));
  });

  it('phiếu đã ghi sổ không ghi sổ lại, không huỷ được', () => {
    for (const s of ['matched', 'short', 'resolved', 'cancelled'] as const) {
      expect(() => to(s, 'post')).toThrow(expect.objectContaining({ code: 'invalid_transition' }));
      expect(() => to(s, 'cancel', kho, rec(), 'x')).toThrow(expect.objectContaining({ code: 'invalid_transition' }));
    }
  });
});
