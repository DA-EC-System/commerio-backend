import { describe, expect, it } from 'vitest';
import { assertTransition } from '#src/modules/core/index.ts';
import { type PackageStatus, platformUpdate } from '#src/modules/order/fulfillment/domain/package.ts';
import {
  allCancelled,
  cancelInitiatorsOf,
  cancelPlan,
  codUnconfirmed,
  completionBlocker,
  DEFAULT_RETURN_POLICY,
  isDueSoon,
  lastDeliveredAt,
  orderCancelReasonFromLines,
  orderMachine,
  outcomeOf,
  returnWindowEndsAt,
  shipByFlag,
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

  const allCancelledOrder = { ...lazadaOrder, packages: ['cancelled', 'cancelled'] as const };

  it('AC19 (D1-03): complete khi mọi kiện đã huỷ → all_packages_cancelled; có kiện không huỷ thì hoàn tất', () => {
    expect(() => assertTransition(orderMachine, 'processing', 'complete', { actor: null, record: allCancelledOrder })).toThrow(
      expect.objectContaining({ code: 'all_packages_cancelled' }),
    );
    expect(
      assertTransition(orderMachine, 'processing', 'complete', { actor: null, record: { ...lazadaOrder, packages: ['cancelled', 'delivered'] } }).to,
    ).toBe('completed');
  });

  it('AC20 (D1-10): auto_cancel chỉ khi có kiện và mọi kiện đã huỷ', () => {
    const autoCancel = (packages: readonly PackageStatus[]) =>
      assertTransition(orderMachine, 'processing', 'auto_cancel', { actor: null, record: { ...lazadaOrder, packages } });
    expect(autoCancel(['cancelled']).to).toBe('cancelled');
    expect(() => autoCancel(['cancelled', 'returned'])).toThrow(expect.objectContaining({ code: 'packages_not_cancelled' }));
    expect(() => autoCancel([])).toThrow(expect.objectContaining({ code: 'packages_not_cancelled' }));
  });

  it('AC21 (D1-10x, D1-03x): người dùng gọi auto_cancel, complete → invalid_transition', () => {
    for (const action of ['auto_cancel', 'complete'] as const) {
      expect(() => assertTransition(orderMachine, 'processing', action, { actor: sale, record: allCancelledOrder })).toThrow(
        expect.objectContaining({ code: 'invalid_transition' }),
      );
    }
  });

  it.each(['unpaid', 'completed', 'cancelled'] as const)('AC22 (D1-X01, X03, X04): %s gọi auto_cancel → invalid_transition', (from) => {
    expect(() => assertTransition(orderMachine, from, 'auto_cancel', { actor: null, record: allCancelledOrder })).toThrow(
      expect.objectContaining({ code: 'invalid_transition' }),
    );
  });

  it('allCancelled: có kiện và mọi kiện đã huỷ', () => {
    expect(allCancelled(['cancelled', 'cancelled'])).toBe(true);
    expect(allCancelled(['cancelled', 'delivered'])).toBe(false);
    expect(allCancelled([])).toBe(false);
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
    [{ packages: ['cancelled', 'cancelled'] }, 'all_packages_cancelled'],
    [{ packages: ['cancelled'], openReturnRequests: 1, codUnconfirmed: true }, 'all_packages_cancelled'],
    [{ packages: ['cancelled', 'reserved'] }, 'packages_open'],
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
  const tiktok = { returnWindow: 'platform_status', returnWindowDays: null } as const;
  const stored = at('2026-11-10T08:00:00Z');
  it('platform_status: trả mốc sàn báo đã lưu, không cộng ngày', () =>
    expect(returnWindowEndsAt(tiktok, d, stored)).toEqual(stored));
  it('platform_status: sàn chưa báo thì null, không rơi về 7 ngày (D8)', () =>
    expect(returnWindowEndsAt(tiktok, d, null)).toBeNull());
  it('platform_status: chưa kiện nào giao thì null dù sàn đã báo', () =>
    expect(returnWindowEndsAt(tiktok, null, stored)).toBeNull());
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

describe('shipByFlag: Sắp trễ hạn ≤ 25%, Trễ hạn (#432)', () => {
  const H = 3_600_000;
  // Đơn TikTok ca test 18/11: về 03:00, hạn 19:00 (16 giờ).
  const startAt = at('2026-11-18T03:00:00Z');
  const shipBy = at('2026-11-18T19:00:00Z');
  const flag = (now: number, packages: PackageStatus[] = ['reserved'], o: Partial<{ shipBy: Date | null; startAt: Date }> = {}) =>
    shipByFlag({ shipBy, startAt, packages, now, ...o });

  it('đơn hạn 16 giờ: không cờ ở giờ đầu, còn trên 25% cũng không', () => {
    expect(flag(startAt.getTime() + H)).toBeNull();
    expect(flag(shipBy.getTime() - 4 * H - 60_000)).toBeNull();
  });
  it('còn đúng 4 giờ (25%) tới trước hạn 1 ms: due_soon', () => {
    expect(flag(shipBy.getTime() - 4 * H)).toBe('due_soon');
    expect(flag(shipBy.getTime() - 1)).toBe('due_soon');
  });
  it('đúng lúc tới hạn và sau hạn: overdue, không due_soon', () => {
    expect(flag(shipBy.getTime())).toBe('overdue');
    expect(flag(shipBy.getTime() + 11 * 24 * H)).toBe('overdue');
  });
  it('chỉ xét kiện chưa bàn giao', () => {
    const late = shipBy.getTime() + H;
    expect(flag(late, ['in_transit', 'delivered'])).toBeNull();
    expect(flag(late, ['cancelled'])).toBeNull();
    expect(flag(late, [])).toBeNull();
    expect(flag(late, ['in_transit', 'packed'])).toBe('overdue');
    expect(flag(late, ['backordered'])).toBe('overdue');
    expect(flag(late, ['awaiting_pickup'])).toBe('overdue');
  });
  it('không có hạn thì không cờ', () => {
    expect(flag(shipBy.getTime() + H, ['reserved'], { shipBy: null })).toBeNull();
  });
  it('đơn đặt sớm, kéo về muộn: tính từ lúc đặt nên còn 8/48 giờ là due_soon', () => {
    const placed = at('2026-11-16T19:00:00Z'); // 48 giờ trước hạn
    expect(flag(shipBy.getTime() - 8 * H, ['reserved'], { startAt: placed })).toBe('due_soon');
  });
  it('mốc bắt đầu không trước hạn: chỉ có thể overdue', () => {
    expect(flag(shipBy.getTime() - H, ['reserved'], { startAt: shipBy })).toBeNull();
    expect(flag(shipBy.getTime() + H, ['reserved'], { startAt: at('2026-11-18T20:00:00Z') })).toBe('overdue');
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

describe('người, lý do huỷ cấp đơn suy ra từ dòng (DH-B06)', () => {
  const line = (cancelledQty: number, cancelInitiator: 'buyer' | 'seller' | 'platform' | null, cancelReason: string | null = null) => ({
    cancelledQty,
    cancelInitiator,
    cancelReason,
  });

  it('nhiều người huỷ: không trùng, thứ tự buyer, seller, platform; bỏ dòng chưa huỷ và dòng không ghi người', () => {
    expect(cancelInitiatorsOf([line(1, 'platform'), line(1, 'buyer'), line(2, 'buyer'), line(0, 'seller'), line(1, null)])).toEqual(['buyer', 'platform']);
    expect(cancelInitiatorsOf([line(0, 'buyer')])).toEqual([]);
  });

  it('mọi món cùng một lý do thì lấy lý do đó', () => {
    expect(orderCancelReasonFromLines([line(1, 'buyer', 'Đổi ý'), line(1, 'buyer', ' Đổi ý '), line(0, null, 'Khác')])).toBe('Đổi ý');
  });

  it('không món nào ghi người lẫn lý do thì "Sàn huỷ đơn"', () => {
    expect(orderCancelReasonFromLines([line(1, null)])).toBe('Sàn huỷ đơn');
  });

  it('nhiều lý do, hay có người huỷ mà không lý do, thì để trống', () => {
    expect(orderCancelReasonFromLines([line(1, 'buyer', 'Đổi ý'), line(1, 'platform', 'Hết hạn giao')])).toBeUndefined();
    expect(orderCancelReasonFromLines([line(1, 'seller')])).toBeUndefined();
  });

  it('một món có lý do, món khác không người không lý do: để trống, không lấy lý do một món làm lý do cả đơn', () => {
    // Khách huỷ món A "Đổi ý", sau đó sàn huỷ B, C không ghi gì: đơn không được trông như khách huỷ cả đơn.
    expect(orderCancelReasonFromLines([line(1, 'buyer', 'Đổi ý'), line(1, null), line(1, null)])).toBeUndefined();
    expect(orderCancelReasonFromLines([line(1, 'buyer', 'Đổi ý'), line(1, 'platform', '  ')])).toBeUndefined();
  });
});
