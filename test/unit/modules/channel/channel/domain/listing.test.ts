import { describe, expect, it } from 'vitest';
import { assertTransition } from '#src/modules/core/index.ts';
import { type ListingAction, type ListingStatus, listingMachine, syncAction } from '#src/modules/channel/channel/domain/listing.ts';

describe('syncAction: trạng thái trên sàn → thao tác', () => {
  it.each([
    ['under_review', 'live', 'approve'],
    ['under_review', 'rejected', 'reject'],
    ['under_review', 'review', null],
    ['live', 'hold', 'hold'],
    ['hidden', 'hold', 'hold'],
    ['platform_hold', 'live', 'release'],
    ['platform_hold', 'hold', null],
    ['live', 'live', null],
    // Sàn tắt sản phẩm ngoài app: chưa có mũi tên trên sơ đồ, để nguyên.
    ['live', 'inactive', null],
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
    'C2-15…20: %s → delist (người có quyền, hoặc sàn báo xoá)',
    (from) => {
      expect(assertTransition(listingMachine, from, 'delist', { actor: staff }).to).toBe('delisted');
      expect(assertTransition(listingMachine, from, 'delist', { actor: null }).to).toBe('delisted');
      expect(() => assertTransition(listingMachine, from, 'delist', { actor: { ...staff, permissions: [] } })).toThrow(
        expect.objectContaining({ status: 403 }),
      );
    },
  );

  it('C2-X05: đang đẩy không gỡ được', () => {
    expect(() => assertTransition(listingMachine, 'pushing', 'delist', { actor: staff })).toThrow(
      expect.objectContaining({ code: 'invalid_transition' }),
    );
  });
});
