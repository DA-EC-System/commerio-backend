import { describe, expect, it } from 'vitest';
import { assertTransition } from '#src/modules/core/index.ts';
import {
  arrowAction,
  canReportLost,
  LOSABLE,
  packageMachine,
  platformUpdate,
} from '#src/modules/order/fulfillment/domain/package.ts';
import type { PackageRecord, PackageStatus } from '#src/modules/order/fulfillment/domain/package.ts';

const warehouse = { accountId: 'kho-a', permissions: ['fulfillment.order.process'], enabledModules: ['fulfillment'] };
const record: PackageRecord = { source: 'manual', selfDelivery: false, orderStatus: 'processing' };

describe('platformUpdate: sàn đẩy trạng thái kiện (spec 199c §5.2, D5)', () => {
  it.each<[PackageStatus, PackageStatus]>([
    ['reserved', 'packed'],
    ['awaiting_pickup', 'in_transit'],
    ['in_transit', 'delivered'],
  ])('direct: %s → %s', (from, to) => {
    expect(platformUpdate(from, to)).toBe('direct');
  });

  it.each<[PackageStatus, PackageStatus]>([
    ['backordered', 'in_transit'],
    ['reserved', 'delivered'],
    // Nhảy ra nhánh giao lỗi từ trước bàn giao (D5): bù bàn giao rồi áp.
    ['reserved', 'delivery_failed'],
    ['awaiting_pickup', 'returning'],
    ['backordered', 'returning'],
    ['packed', 'delivery_failed'],
  ])('jump: %s → %s', (from, to) => {
    expect(platformUpdate(from, to)).toBe('jump');
  });

  it.each<[PackageStatus, PackageStatus]>([
    // `reserved → lost` thành `jump` từ #238 (D18), xem describe 'thất lạc (#238)'.
    ['delivered', 'lost'],
    ['delivered', 'returning'],
    ['in_transit', 'reserved'],
  ])('invalid: %s → %s', (from, to) => {
    expect(platformUpdate(from, to)).toBe('invalid');
  });
});

describe('thất lạc (#238)', () => {
  it('D2-25..29: lose chỉ từ sau bàn giao, không từ awaiting_pickup', () => {
    expect(arrowAction('awaiting_pickup', 'lost')).toBe('lose_on_unload');
    for (const s of ['in_transit', 'delivery_failed', 'returning', 'self_delivering'] as const) expect(arrowAction(s, 'lost')).toBe('lose');
  });

  it('đường sàn ưu tiên mũi tên hệ thống', () => {
    expect(arrowAction('in_transit', 'lost', { system: true })).toBe('platform_lost');
    expect(arrowAction('in_transit', 'delivered', { system: true })).toBe('deliver'); // không có mũi tên hệ thống thì như cũ
  });

  it('D2-32: lose_on_unload cần cờ Cần mở', () => {
    const ctx = { actor: warehouse, record: { ...record, needsOpen: false, createdBy: 'khac' }, reason: 'x' };
    expect(() => assertTransition(packageMachine, 'packed', 'lose_on_unload', ctx)).toThrowError(
      expect.objectContaining({ code: 'not_awaiting_open', status: 409 }),
    );
    expect(
      assertTransition(packageMachine, 'awaiting_pickup', 'lose_on_unload', { ...ctx, record: { ...ctx.record, needsOpen: true } }).to,
    ).toBe('lost');
  });

  it('lose cần người khác người báo, trừ ngoại lệ tự duyệt', () => {
    const self = { actor: warehouse, record: { ...record, createdBy: warehouse.accountId }, reason: 'x' };
    expect(() => assertTransition(packageMachine, 'in_transit', 'lose', self)).toThrowError(
      expect.objectContaining({ code: 'second_person_required' }),
    );
    expect(assertTransition(packageMachine, 'in_transit', 'lose', { ...self, canSelfApprove: true })).toEqual({ to: 'lost', selfApproved: true });
  });

  it('D2-33..36: sàn kéo lại chỉ khi trạng thái do người chuyển tay', () => {
    expect(platformUpdate('lost', 'in_transit', { statusSource: 'user' })).toBe('direct');
    expect(platformUpdate('lost', 'delivered', { statusSource: 'user' })).toBe('direct');
    expect(platformUpdate('returning', 'delivered', { statusSource: 'user' })).toBe('direct');
    expect(platformUpdate('lost', 'in_transit', { statusSource: 'marketplace' })).toBe('invalid');
    expect(platformUpdate('lost', 'in_transit')).toBe('invalid');
  });

  it('D18: kiện trước bàn giao mà sàn báo lost là nhảy cóc', () => {
    for (const s of ['backordered', 'reserved', 'packed', 'awaiting_pickup'] as const) expect(platformUpdate(s, 'lost')).toBe('jump');
    expect(platformUpdate('in_transit', 'lost')).toBe('direct');
  });

  it('replaced: packed, awaiting_pickup → cancelled, chỉ hệ thống (PR 3, §5.2)', () => {
    for (const s of ['packed', 'awaiting_pickup'] as const) {
      expect(assertTransition(packageMachine, s, 'replaced', { actor: null }).to).toBe('cancelled');
      expect(() => assertTransition(packageMachine, s, 'replaced', { actor: warehouse })).toThrowError(
        expect.objectContaining({ code: 'invalid_transition', status: 409 }),
      );
    }
    for (const s of ['backordered', 'reserved', 'in_transit'] as const) {
      expect(() => assertTransition(packageMachine, s, 'replaced', { actor: null })).toThrowError(
        expect.objectContaining({ code: 'invalid_transition' }),
      );
    }
    // Đứng sau `open_cancel`: mũi tên khớp đầu tiên không đổi.
    expect(arrowAction('packed', 'cancelled')).toBe('open_cancel');
    expect(arrowAction('awaiting_pickup', 'cancelled')).toBe('open_cancel');
  });

  it('canReportLost', () => {
    expect(LOSABLE.filter(canReportLost)).toHaveLength(6);
    for (const s of ['backordered', 'reserved', 'delivered', 'returned', 'lost', 'cancelled'] as const) expect(canReportLost(s)).toBe(false);
  });
});

describe('giữ hàng, lấy lại phần giữ là bước của hệ thống (US-DH-04 dòng 5)', () => {
  // CEO có mọi quyền của kiện: bị chặn vì là người dùng, không phải vì thiếu quyền.
  const ceo = {
    accountId: 'ceo-a',
    permissions: ['fulfillment.order.process', 'fulfillment.handover.revert'],
    enabledModules: ['fulfillment'],
  };

  it.each<[string, PackageStatus, 'hold' | 'reclaim', PackageStatus]>([
    ['D2-01x', 'backordered', 'hold', 'reserved'],
    ['D2-02x', 'reserved', 'reclaim', 'backordered'],
  ])('%s: kiện %s, người dùng gọi %s → 409 invalid_transition; hệ thống thì qua', (_, from, action, to) => {
    expect(() => assertTransition(packageMachine, from, action, { actor: ceo, record })).toThrowError(
      expect.objectContaining({ code: 'invalid_transition', status: 409 }),
    );
    expect(assertTransition(packageMachine, from, action, { actor: null, record }).to).toBe(to);
  });
});
