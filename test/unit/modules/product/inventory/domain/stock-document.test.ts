import { describe, expect, it } from 'vitest';
import {
  adjustmentMachine,
  decreaseOf,
  inspectionMachine,
  missingOf,
  needsDecision,
} from '#src/modules/product/inventory/domain/stock-document.ts';
import { assertTransition } from '#src/modules/core/index.ts';

const kho = { accountId: 'kho', permissions: ['inventory.receipt.create'], enabledModules: ['inventory'] };
const ceo = { accountId: 'ceo', permissions: ['inventory.receipt.create', 'inventory.document.approve'], enabledModules: ['inventory'] };
const record = { createdBy: 'kho', lineCount: 1, missing: 0 };

describe('phiếu kho (#208)', () => {
  it('phần giảm: kiểm kê lấy phần đếm thiếu, phiếu khác lấy số lượng', () => {
    expect(decreaseOf('stocktake', { quantity: null, bookQty: 10, countedQty: 8 })).toBe(2);
    expect(decreaseOf('stocktake', { quantity: null, bookQty: 10, countedQty: 12 })).toBe(0);
    expect(decreaseOf('write_off', { quantity: 3, bookQty: null, countedQty: null })).toBe(3);
  });

  it('phần thiếu của kiểm hàng về chỉ tính dòng quét ít hơn dự kiến', () => {
    expect(missingOf([{ expected: 3, scanned: 1 }, { expected: 0, scanned: 2 }, { expected: 1, scanned: 1 }])).toBe(2);
  });

  it('chỉ xuất huỷ chờ xử lý bị từ chối mà chưa chọn mới cần chọn cách xử lý', () => {
    const doc = { kind: 'write_off', area: 'quarantine', status: 'rejected', rejectDecision: null };
    expect(needsDecision(doc)).toBe(true);
    expect(needsDecision({ ...doc, rejectDecision: 'restock' })).toBe(false);
    expect(needsDecision({ ...doc, area: 'on_hand' })).toBe(false);
  });

  it('duyệt phiếu giảm cần người khác người lập, CEO tự lập được tự duyệt', () => {
    expect(() => assertTransition(adjustmentMachine, 'pending', 'approve', { actor: { ...ceo, accountId: 'kho' }, record })).toThrow(
      expect.objectContaining({ code: 'second_person_required' }),
    );
    expect(
      assertTransition(adjustmentMachine, 'pending', 'approve', { actor: { ...ceo, accountId: 'kho' }, record, canSelfApprove: true }),
    ).toEqual({ to: 'posted', selfApproved: true });
    expect(() => assertTransition(adjustmentMachine, 'pending', 'approve', { actor: kho, record: { ...record, createdBy: 'x' } })).toThrow(
      expect.objectContaining({ code: 'forbidden' }),
    );
  });

  it('kiểm hàng về: không thiếu thì ghi sổ thẳng, có thiếu thì phải gửi duyệt', () => {
    expect(assertTransition(inspectionMachine, 'draft', 'post', { actor: kho, record })).toEqual({ to: 'posted', selfApproved: false });
    expect(() => assertTransition(inspectionMachine, 'draft', 'post', { actor: kho, record: { ...record, missing: 1 } })).toThrow(
      expect.objectContaining({ code: 'shortage_needs_review' }),
    );
    expect(() => assertTransition(inspectionMachine, 'draft', 'submit', { actor: kho, record })).toThrow(
      expect.objectContaining({ code: 'no_shortage' }),
    );
  });
});
