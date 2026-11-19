import { describe, expect, it } from 'vitest';
import { assertTransition } from '#src/modules/core/index.ts';
import { platformUpdate } from '#src/modules/order/fulfillment/domain/package.ts';
import {
  cancelPlan,
  codUnconfirmed,
  completionBlocker,
  DEFAULT_RETURN_POLICY,
  isDueSoon,
  lastDeliveredAt,
  orderMachine,
  outcomeOf,
  returnWindowEndsAt,
  stageOf,
} from '#src/modules/order/sales/domain/order.ts';

const DAY = 86_400_000;
const at = (iso: string) => new Date(iso);

const sale = { accountId: 'a', permissions: ['sales.order.cancel', 'sales.order.create'], enabledModules: ['sales'] };
const lazadaOrder = { source: 'marketplace' as const, paymentMethod: null, packages: ['reserved' as const] };

describe('máy trạng thái đơn', () => {
  it('sàn báo trả, sàn huỷ: chỉ hệ thống chuyển', () => {
    expect(assertTransition(orderMachine, 'unpaid', 'pay', { actor: null }).to).toBe('processing');
    expect(assertTransition(orderMachine, 'processing', 'platform_cancel', { actor: null }).to).toBe('cancelled');
    expect(() => assertTransition(orderMachine, 'unpaid', 'pay', { actor: sale })).toThrow(
      expect.objectContaining({ code: 'invalid_transition' }),
    );
  });

  it('huỷ đơn sàn trong app bị chặn ở route huỷ thường, đi được bằng huỷ trên sàn khi chưa bàn giao', () => {
    expect(() => assertTransition(orderMachine, 'processing', 'cancel', { actor: sale, record: lazadaOrder, reason: 'x' })).toThrow(
      expect.objectContaining({ code: 'not_allowed_for_source' }),
    );
    expect(assertTransition(orderMachine, 'processing', 'cancel_on_platform', { actor: sale, record: lazadaOrder }).to).toBe(
      'cancelled',
    );
    expect(() =>
      assertTransition(orderMachine, 'processing', 'cancel_on_platform', {
        actor: sale,
        record: { ...lazadaOrder, packages: ['in_transit'] },
      }),
    ).toThrow(expect.objectContaining({ code: 'already_handed_over' }));
  });

  it('đơn đã hoàn tất không huỷ được', () => {
    expect(() => assertTransition(orderMachine, 'completed', 'platform_cancel', { actor: null })).toThrow(
      expect.objectContaining({ code: 'invalid_transition' }),
    );
  });
});

describe('cancelPlan, outcomeOf, completionBlocker', () => {
  it('còn kiện đã đóng gói thì huỷ sau khi mở', () => {
    expect(cancelPlan(['reserved', 'backordered'])).toBe('now');
    expect(cancelPlan(['reserved', 'awaiting_pickup'])).toBe('after_open');
  });

  it('kết quả tính trên kiện chưa huỷ', () => {
    expect(outcomeOf(['delivered', 'cancelled'])).toBe('full');
    expect(outcomeOf(['delivered', 'returned'])).toBe('partial');
    expect(outcomeOf(['lost', 'cancelled'])).toBe('none');
  });

  const now = Date.parse('2026-10-29T00:00:00Z');
  const base = { lastDeliveredAt: null, returnWindowEndsAt: null, openReturnRequests: 0, codUnconfirmed: false, now };
  const past = { lastDeliveredAt: at('2026-10-20T00:00:00Z'), returnWindowEndsAt: at('2026-10-27T00:00:00Z') };

  it.each([
    [{ packages: ['in_transit'] }, 'packages_open'],
    [{ packages: [] }, 'packages_open'],
    [{ packages: ['delivered'], lastDeliveredAt: at('2026-10-25T00:00:00Z'), returnWindowEndsAt: at('2026-11-01T00:00:00Z') }, 'return_window'],
    [{ packages: ['delivered'], lastDeliveredAt: at('2026-10-20T00:00:00Z'), returnWindowEndsAt: at('2026-10-27T00:00:00Z') }, null],
    [{ packages: ['delivered'], lastDeliveredAt: at('2026-10-20T00:00:00Z'), returnWindowEndsAt: null }, 'return_window'],
    [{ packages: ['delivered'], ...past, openReturnRequests: 1 }, 'return_requested'],
    [{ packages: ['delivered'], ...past, codUnconfirmed: true }, 'cod_unconfirmed'],
    [{ packages: ['delivered', 'cancelled'], ...past }, null],
    [{ packages: ['returned'] }, null],
  ] as const)('%o → %s', (input, expected) => {
    expect(completionBlocker({ ...base, ...input })).toBe(expected);
  });
});

describe('returnWindowEndsAt', () => {
  const d = at('2026-11-01T00:00:00Z');
  it('sàn days: mốc giao + số ngày của gian hàng', () =>
    expect(returnWindowEndsAt({ returnWindow: 'days', returnWindowDays: 15 }, d, null)).toEqual(new Date(d.getTime() + 15 * DAY)));
  it('gian hàng chưa nhập số ngày: 7 ngày', () =>
    expect(returnWindowEndsAt({ returnWindow: 'days', returnWindowDays: null }, d, null)).toEqual(new Date(d.getTime() + 7 * DAY)));
  it('PR 1: sàn platform_status vẫn 7 ngày, bỏ qua cột đã lưu (D13)', () =>
    expect(returnWindowEndsAt({ returnWindow: 'platform_status', returnWindowDays: null }, d, null)).toEqual(
      new Date(d.getTime() + 7 * DAY),
    ));
  it('chưa kiện nào giao: null', () => expect(returnWindowEndsAt(DEFAULT_RETURN_POLICY, null, null)).toBeNull());
});

describe('codUnconfirmed', () => {
  const p = { selfDelivery: true, status: 'delivered', codExpected: '100000.00', codConfirmedAt: null } as const;
  it.each([
    [p, true],
    [{ ...p, codConfirmedAt: at('2026-11-02T00:00:00Z') }, false],
    [{ ...p, codExpected: '0.00' }, false],
    [{ ...p, codExpected: null }, false],
    [{ ...p, status: 'returned' }, false],
    [{ ...p, selfDelivery: false }, false],
  ] as const)('%o → %s', (pkg, expected) => expect(codUnconfirmed([pkg])).toBe(expected));
});

it('lastDeliveredAt lấy mốc lớn nhất, bỏ null', () =>
  expect(
    lastDeliveredAt([{ deliveredAt: null }, { deliveredAt: at('2026-11-02T00:00:00Z') }, { deliveredAt: at('2026-11-01T00:00:00Z') }]),
  ).toEqual(at('2026-11-02T00:00:00Z')));

describe('stageOf', () => {
  const o = { status: 'processing' as const, source: 'marketplace' as const, paymentMethod: null, flags: [] };

  it.each([
    [{ status: 'cancelled' }, 'cancelled'],
    [{ flags: ['unmapped_sku'] }, 'unmapped'],
    [{ status: 'unpaid' }, 'awaiting_payment'],
    [{ status: 'unpaid', source: 'manual', paymentMethod: 'cod' }, 'awaiting_confirmation'],
    [{ flags: ['cancelling'], packages: ['packed'] }, 'cancelling'],
    [{ packages: ['delivered', 'lost'] }, 'lost'],
    [{ packages: ['delivered', 'returned'] }, 'awaiting_completion'],
    [{ packages: ['in_transit', 'packed', 'cancelled'] }, 'packed'],
    [{ packages: ['backordered', 'reserved'] }, 'backordered'],
  ] as const)('%o → %s', (input, expected) => {
    expect(stageOf({ ...o, packages: [], ...input })).toBe(expected);
  });
});

describe('isDueSoon', () => {
  const now = Date.parse('2026-10-29T00:00:00Z');
  it('còn kiện chưa rời kho và hạn dưới 24 giờ', () => {
    expect(isDueSoon('2026-10-29T10:00:00Z', ['reserved'], now)).toBe(true);
    expect(isDueSoon('2026-10-31T10:00:00Z', ['reserved'], now)).toBe(false);
    expect(isDueSoon('2026-10-29T10:00:00Z', ['in_transit'], now)).toBe(false);
    expect(isDueSoon(null, ['reserved'], now)).toBe(false);
  });
});

describe('platformUpdate: sàn đẩy trạng thái kiện', () => {
  it.each([
    ['reserved', 'packed', 'direct'],
    ['reserved', 'in_transit', 'jump'],
    ['backordered', 'delivered', 'jump'],
    ['in_transit', 'delivered', 'direct'],
    ['in_transit', 'returning', 'direct'],
    ['delivered', 'packed', 'invalid'],
    ['returned', 'in_transit', 'invalid'],
  ] as const)('%s → %s: %s', (from, to, expected) => {
    expect(platformUpdate(from, to)).toBe(expected);
  });
});
