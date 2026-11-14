import { describe, expect, it } from 'vitest';
import { assertTransition } from '#src/modules/core/index.ts';
import {
  distributeResell,
  OPEN_RETURN_STATUSES,
  refundAmountOf,
  returnMachine,
  syncAction,
  weightedUnitCost,
} from '#src/modules/order/sales/domain/return.ts';

const sale = { accountId: 'a', permissions: ['sales.return.process', 'sales.return.view'], enabledModules: ['sales'] };
const warehouse = { accountId: 'k', permissions: ['fulfillment.order.process'], enabledModules: ['fulfillment'] };
const marketplace = { source: 'marketplace' as const };
const manual = { source: 'manual' as const };

describe('máy trạng thái yêu cầu trả (D3-*, Documents/21 §20)', () => {
  it.each([
    ['requested', 'accept', 'awaiting_return'],
    ['requested', 'refund_only', 'refund_only'],
    ['rejected', 'platform_reopen', 'awaiting_return'],
    ['rejected', 'platform_refund', 'refund_only'],
  ] as const)('Sale làm %s → %s → %s', (from, action, to) => {
    expect(assertTransition(returnMachine, from, action, { actor: sale, record: marketplace }).to).toBe(to);
  });

  it('từ chối và khách không gửi hàng bắt buộc lý do', () => {
    expect(() => assertTransition(returnMachine, 'requested', 'reject', { actor: sale, record: manual })).toThrow(
      expect.objectContaining({ code: 'reason_required', status: 422 }),
    );
    expect(assertTransition(returnMachine, 'awaiting_return', 'no_show', { actor: sale, record: manual, reason: 'Quá hạn' }).to).toBe('closed');
  });

  it('nhận hàng trả cần quyền kho, Sale không có thì 403', () => {
    expect(assertTransition(returnMachine, 'awaiting_return', 'receive', { actor: warehouse, record: manual }).to).toBe('received');
    expect(() => assertTransition(returnMachine, 'awaiting_return', 'receive', { actor: sale, record: manual })).toThrow(
      expect.objectContaining({ code: 'forbidden' }),
    );
  });

  it('yêu cầu chỉ hoàn tiền không có bước đồng ý trả hàng (review #202 mục 3)', () => {
    const refundOnly = { source: 'marketplace' as const, kind: 'refund' as const };
    expect(() => assertTransition(returnMachine, 'requested', 'accept', { actor: sale, record: refundOnly })).toThrow(
      expect.objectContaining({ code: 'refund_only_request' }),
    );
    expect(assertTransition(returnMachine, 'requested', 'refund_only', { actor: sale, record: refundOnly }).to).toBe('refund_only');
  });

  it('sàn phân xử chỉ cho yêu cầu từ sàn', () => {
    expect(() => assertTransition(returnMachine, 'rejected', 'platform_reopen', { actor: sale, record: manual })).toThrow(
      expect.objectContaining({ code: 'not_marketplace' }),
    );
  });

  it('đóng và khách rút chỉ hệ thống làm; sai trạng thái 409 invalid_transition', () => {
    expect(() => assertTransition(returnMachine, 'received', 'close', { actor: sale, record: manual })).toThrow(
      expect.objectContaining({ code: 'invalid_transition' }),
    );
    expect(assertTransition(returnMachine, 'received', 'close', { actor: null, record: manual }).to).toBe('closed');
    expect(assertTransition(returnMachine, 'awaiting_return', 'buyer_cancel', { actor: null, record: marketplace }).to).toBe('closed');
    expect(() => assertTransition(returnMachine, 'received', 'buyer_cancel', { actor: null, record: marketplace })).toThrow(
      expect.objectContaining({ code: 'invalid_transition', status: 409 }),
    );
    expect(() => assertTransition(returnMachine, 'refund_only', 'accept', { actor: sale, record: marketplace })).toThrow(
      expect.objectContaining({ code: 'invalid_transition' }),
    );
  });

  it('refund_only không tính là yêu cầu mở (§19.1)', () => {
    expect(OPEN_RETURN_STATUSES).toEqual(['requested', 'awaiting_return', 'received']);
  });
});

describe('syncAction: trạng thái sàn → bước của app (25 §9)', () => {
  it.each([
    ['requested', 'awaiting_return', 'accept'],
    ['requested', 'rejected', 'reject'],
    ['requested', 'refund_only', 'refund_only'],
    ['rejected', 'awaiting_return', 'platform_reopen'],
    ['rejected', 'refund_only', 'platform_refund'],
    ['requested', 'closed', 'buyer_cancel'],
    ['awaiting_return', 'closed', 'buyer_cancel'],
    ['awaiting_return', 'received', null],
    // Lần kéo đầu đã thấy hàng về: đồng ý thay người bán rồi chờ kho quét (review #202 mục 1).
    ['requested', 'received', 'accept'],
    ['rejected', 'received', 'platform_reopen'],
    ['refund_only', 'received', 'conflict'],
    // Đã từ chối rồi khách huỷ trên sàn (người bán thắng): giữ `rejected`, như TikTok (channel CLAUDE.md).
    ['rejected', 'closed', null],
    ['received', 'refund_only', null],
    ['requested', 'requested', null],
    ['closed', 'awaiting_return', 'conflict'],
    ['refund_only', 'rejected', 'conflict'],
  ] as const)('%s, sàn báo %s → %s', (current, target, action) => {
    expect(syncAction(current, target)).toBe(action);
  });
});

describe('tiền và giá vốn', () => {
  it('giá vốn bình quân gia quyền các dòng kiện đã giao (E99)', () => {
    expect(weightedUnitCost([{ quantity: 1, unitCost: '10000' }, { quantity: 3, unitCost: '14000' }])).toBe('13000.00');
    expect(weightedUnitCost([{ quantity: 2, unitCost: null }])).toBeNull();
    expect(weightedUnitCost([{ quantity: 1, unitCost: null }, { quantity: 1, unitCost: '5000' }])).toBe('5000.00');
  });

  it('tiền hoàn = Σ số trả × đơn giá', () => {
    expect(refundAmountOf([{ quantity: 2, unitPrice: '32000' }, { quantity: 1, unitPrice: '1500.50' }])).toBe('65500.50');
  });

  it('chia số bán lại theo dòng, resellCost bỏ dòng không có giá vốn', () => {
    const lines = [
      { id: '1', variantId: 'A', quantity: 2, unitCost: '10000.00' },
      { id: '2', variantId: 'A', quantity: 1, unitCost: null },
      { id: '3', variantId: 'B', quantity: 1, unitCost: '7000.00' },
    ];
    const r = distributeResell(lines, new Map([['A', 3], ['B', 0]]));
    expect([...r.perLine]).toEqual([['1', 2], ['2', 1], ['3', 0]]);
    expect(r.resellCost).toBe('20000.00');
  });
});
