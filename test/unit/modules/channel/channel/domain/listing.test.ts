import { describe, expect, it } from 'vitest';
import { assertTransition } from '#src/modules/core/index.ts';
import { type ListingAction, type ListingStatus, listingMachine, stockDecision, syncAction, visibilityAction } from '#src/modules/channel/channel/domain/listing.ts';

describe('syncAction: trạng thái trên sàn → thao tác', () => {
  it.each([
    ['under_review', 'live', 'approve'],
    ['under_review', 'rejected', 'reject'],
    // Sàn từ chối cả sản phẩm khi listing đang bán, đang ẩn (#389).
    ['live', 'rejected', 'reject'],
    ['hidden', 'rejected', 'reject'],
    ['platform_hold', 'rejected', null],
    ['under_review', 'review', null],
    ['live', 'hold', 'hold'],
    ['hidden', 'hold', 'hold'],
    ['platform_hold', 'live', 'release'],
    ['platform_hold', 'hold', null],
    ['live', 'live', null],
    // Sàn tắt ngoài app (#360, 21 §18.3 `outside_hold`); listing app đã ẩn (sàn tắt do chính app) giữ nguyên.
    ['live', 'inactive', 'outside_hold'],
    ['hidden', 'inactive', null],
    ['under_review', 'inactive', null],
    ['platform_hold', 'inactive', null],
    ['rejected', 'live', null],
  ] as const)('%s + sàn %s → %s', (status, remote, action) => {
    expect(syncAction(status, remote)).toBe(action);
  });

  // E24, 25 §6.4 "gỡ trên sàn (sàn báo về)" (#219).
  it.each(['under_review', 'live', 'hidden', 'platform_hold', 'rejected', 'push_failed'] as const)(
    '%s + sàn đã xoá → delist',
    (status) => {
      expect(syncAction(status, 'deleted')).toBe('delist');
    },
  );

  it.each(['pushing', 'delisted'] as const)('%s + sàn đã xoá → không đổi', (status) => {
    expect(syncAction(status, 'deleted')).toBeNull();
  });
});

const staff = { accountId: 'a', permissions: ['channel.listing.manage'], enabledModules: ['channel'] };
const ALL: ListingAction[] = [
  'push',
  'go_live',
  'send_review',
  'fail',
  'approve',
  'reject',
  'hold',
  'release',
  'hide',
  'unhide',
  'delist',
  'update_content',
  'request_review',
];

describe('máy trạng thái listing (Documents/21 §18.3, ca C2)', () => {
  it.each(['push_failed', 'rejected', 'platform_hold'] as const)('C2-02…04: %s → push → pushing', (from) => {
    expect(assertTransition(listingMachine, from, 'push', { actor: staff }).to).toBe('pushing');
  });

  it.each(['push_failed', 'rejected', 'platform_hold'] as const)('C2-02q…04q: %s, thiếu quyền → 403', (from) => {
    expect(() => assertTransition(listingMachine, from, 'push', { actor: { ...staff, permissions: [] } })).toThrow(
      expect.objectContaining({ status: 403, code: 'forbidden' }),
    );
  });

  // C2-X05…X09: trạng thái không đẩy được. Qua API, `pushing` ra dòng `push_in_progress`, `under_review`/`live`/`hidden`
  // ra `already_listed`, `delisted` tạo bản ghi mới; máy trạng thái thì từ chối.
  it.each(['pushing', 'under_review', 'live', 'hidden', 'delisted'] as const)('C2-X: %s → push → 409', (from) => {
    expect(() => assertTransition(listingMachine, from, 'push', { actor: staff })).toThrow(
      expect.objectContaining({ status: 409, code: 'invalid_transition' }),
    );
  });

  it('C2-X09: delisted là trạng thái cuối', () => {
    for (const action of ALL) {
      expect(() => assertTransition(listingMachine, 'delisted', action, { actor: null })).toThrow(
        expect.objectContaining({ code: 'invalid_transition' }),
      );
    }
  });

  it('C2-05…07: kết quả đẩy chỉ hệ thống chuyển', () => {
    expect(assertTransition(listingMachine, 'pushing', 'go_live', { actor: null }).to).toBe('live');
    expect(assertTransition(listingMachine, 'pushing', 'send_review', { actor: null }).to).toBe('under_review');
    expect(assertTransition(listingMachine, 'pushing', 'fail', { actor: null }).to).toBe('push_failed');
    for (const action of ['go_live', 'send_review', 'fail'] as const) {
      expect(() => assertTransition(listingMachine, 'pushing', action, { actor: staff })).toThrow(
        expect.objectContaining({ code: 'invalid_transition' }),
      );
    }
  });

  it('C2-08…12: kết quả duyệt, khoá chỉ hệ thống chuyển', () => {
    const cases: [ListingStatus, ListingAction, ListingStatus][] = [
      ['under_review', 'approve', 'live'],
      ['under_review', 'reject', 'rejected'],
      ['live', 'hold', 'platform_hold'],
      ['hidden', 'hold', 'platform_hold'],
      ['platform_hold', 'release', 'live'],
    ];
    for (const [from, action, to] of cases) {
      expect(assertTransition(listingMachine, from, action, { actor: null }).to).toBe(to);
      expect(() => assertTransition(listingMachine, from, action, { actor: staff })).toThrow(
        expect.objectContaining({ code: 'invalid_transition' }),
      );
    }
  });

  it.each(['live', 'hidden', 'under_review', 'platform_hold', 'rejected', 'push_failed'] as const)(
    'C2-17…20: %s → delist (người có quyền, hoặc sàn báo xoá)',
    (from) => {
      expect(assertTransition(listingMachine, from, 'delist', { actor: staff }).to).toBe('delisted');
      expect(assertTransition(listingMachine, from, 'delist', { actor: null }).to).toBe('delisted');
      expect(() => assertTransition(listingMachine, from, 'delist', { actor: { ...staff, permissions: [] } })).toThrow(
        expect.objectContaining({ status: 403 }),
      );
    },
  );

  it('C2-24, C2-25, C2-24q: live → update_content giữ live (người có quyền); sàn ngừng bán bản cũ thì hệ thống request_review → under_review', () => {
    expect(assertTransition(listingMachine, 'live', 'update_content', { actor: staff }).to).toBe('live');
    expect(() => assertTransition(listingMachine, 'live', 'update_content', { actor: { ...staff, permissions: [] } })).toThrow(
      expect.objectContaining({ status: 403 }),
    );
    expect(assertTransition(listingMachine, 'live', 'request_review', { actor: null }).to).toBe('under_review');
    expect(() => assertTransition(listingMachine, 'live', 'request_review', { actor: staff })).toThrow(
      expect.objectContaining({ code: 'invalid_transition' }),
    );
  });

  it.each(['pushing', 'push_failed', 'under_review', 'rejected', 'hidden', 'platform_hold'] as const)(
    'C2-X: %s → update_content → 409 (#293)',
    (from) => {
      expect(() => assertTransition(listingMachine, from, 'update_content', { actor: staff })).toThrow(
        expect.objectContaining({ status: 409, code: 'invalid_transition' }),
      );
    },
  );

  it('C2-X05: đang đẩy không gỡ được', () => {
    expect(() => assertTransition(listingMachine, 'pushing', 'delist', { actor: staff })).toThrow(
      expect.objectContaining({ code: 'invalid_transition' }),
    );
  });
});

describe('stockDecision: đối chiếu tồn sàn với số có thể bán (25 §6.5, #223)', () => {
  it.each([
    // [stockSync, platformStock, sàn, app, kết quả]
    ['synced', 5, 5, 5, 'match'],
    ['error', 3, 5, 5, 'match'],
    ['synced', 5, 8, 5, 'push'],
    ['error', 5, 8, 5, 'push'],
    ['synced', 5, 3, 5, 'wait'],
    ['synced', null, 3, 5, 'wait'],
    ['synced', 3, 3, 5, 'drift'],
    ['synced', 2, 3, 5, 'drift'],
    ['error', 5, 3, 5, 'wait'],
    ['error', 3, 3, 5, 'drift'],
  ] as const)('%s, platform_stock %s, sàn %i, app %i → %s', (stockSync, platformStock, remote, available, expected) => {
    expect(stockDecision({ stockSync, platformStock }, remote, available)).toBe(expected);
  });

  // #430: sàn vẫn cao hơn ngay sau khi app vừa đẩy đúng số (Lazada bán tổng hai kho, app đẩy một kho).
  const now = new Date('2026-11-19T10:00:00Z');
  const ago = (min: number) => new Date(now.getTime() - min * 60_000);
  it.each([
    // [stockSync, platformStock, lần đẩy trước (phút), kết quả]
    ['synced', 5, 15, 'drift'],
    ['synced', 5, 45, 'push'],
    ['synced', 5, null, 'push'],
    ['synced', 3, 15, 'push'],
    ['pending', 5, 15, 'push'],
    ['error', 5, 15, 'push'],
  ] as const)('sàn 8, app 5: %s, platform_stock %s, đẩy %s phút trước → %s', (stockSync, platformStock, min, expected) => {
    const lastPushedAt = min === null ? null : ago(min);
    expect(stockDecision({ stockSync, platformStock, lastPushedAt }, 8, 5, now)).toBe(expected);
  });
});

describe('ẩn, hiện theo trạng thái SKU (#224, 25 §6.4, ca C2-13, C2-14)', () => {
  it('C2-13, C2-14: chỉ hệ thống chuyển', () => {
    expect(assertTransition(listingMachine, 'live', 'hide', { actor: null }).to).toBe('hidden');
    expect(assertTransition(listingMachine, 'hidden', 'unhide', { actor: null }).to).toBe('live');
  });

  it.each([
    ['live', 'hide'],
    ['hidden', 'unhide'],
  ] as const)('C2-13x, C2-14x: người dùng gọi %s → %s → 409 invalid_transition', (from, action) => {
    expect(() => assertTransition(listingMachine, from, action, { actor: staff })).toThrow(
      expect.objectContaining({ status: 409, code: 'invalid_transition' }),
    );
  });

  it.each([
    ['live', true, false, 'hide'],
    ['live', false, false, null],
    ['hidden', false, true, 'unhide'],
    // Ẩn không do app (nối lại gian hàng khi sàn đang tắt): bỏ tạm ngừng không đưa về live (25 §6.4).
    ['hidden', false, false, null],
    ['hidden', true, true, null],
    // E25: chưa live thì chờ; lượt sàn duyệt (`approve`) xong mới ẩn.
    ['under_review', true, false, null],
    ['platform_hold', true, false, null],
    ['pushing', true, false, null],
  ] as const)('%s, tạm ngừng %s, app ẩn %s → %s', (status, paused, appHidden, action) => {
    expect(visibilityAction(status, paused, appHidden)).toBe(action);
  });
});

describe('sàn đổi listing ngoài app (#360, 21 §18.3)', () => {
  it('outside_hold: chỉ sàn (hệ thống) chuyển live → hidden', () => {
    expect(assertTransition(listingMachine, 'live', 'outside_hold', { actor: null }).to).toBe('hidden');
    expect(() => assertTransition(listingMachine, 'live', 'outside_hold', { actor: staff })).toThrow(
      expect.objectContaining({ status: 409, code: 'invalid_transition' }),
    );
  });

  it('outside_resolve: người có listing.manage chuyển hidden → live (vai trò CEO kiểm ở route)', () => {
    expect(assertTransition(listingMachine, 'hidden', 'outside_resolve', { actor: staff }).to).toBe('live');
    expect(() => assertTransition(listingMachine, 'live', 'outside_resolve', { actor: staff })).toThrow(
      expect.objectContaining({ status: 409, code: 'invalid_transition' }),
    );
  });
});
