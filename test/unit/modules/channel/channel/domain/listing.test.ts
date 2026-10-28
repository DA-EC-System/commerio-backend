import { describe, expect, it } from 'vitest';
import { assertTransition } from '#src/modules/core/index.ts';
import { listingMachine, syncAction } from '#src/modules/channel/channel/domain/listing.ts';

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
    // Sàn tắt hay xoá sản phẩm ngoài app: chưa có mũi tên trên sơ đồ, để nguyên.
    ['live', 'inactive', null],
    ['rejected', 'live', null],
  ] as const)('%s + sàn %s → %s', (status, remote, action) => {
    expect(syncAction(status, remote)).toBe(action);
  });
});

const staff = { accountId: 'a', permissions: ['channel.listing.manage'], enabledModules: ['channel'] };

describe('máy trạng thái listing', () => {
  it('đẩy lại được sau lỗi, bị từ chối, đã gỡ; đang đẩy thì 409', () => {
    for (const from of ['push_failed', 'rejected', 'delisted', 'live', 'under_review'] as const) {
      expect(assertTransition(listingMachine, from, 'push', { actor: staff }).to).toBe('pushing');
    }
    expect(() => assertTransition(listingMachine, 'pushing', 'push', { actor: staff })).toThrow(
      expect.objectContaining({ status: 409, code: 'invalid_transition' }),
    );
  });

  it('kết quả từ sàn chỉ hệ thống chuyển', () => {
    expect(assertTransition(listingMachine, 'pushing', 'send_review', { actor: null }).to).toBe('under_review');
    expect(assertTransition(listingMachine, 'under_review', 'reject', { actor: null }).to).toBe('rejected');
    expect(assertTransition(listingMachine, 'platform_hold', 'release', { actor: null }).to).toBe('live');
    expect(() => assertTransition(listingMachine, 'under_review', 'approve', { actor: staff })).toThrow(
      expect.objectContaining({ code: 'invalid_transition' }),
    );
  });

  it('gỡ cần channel.listing.manage và không gỡ được khi đang đẩy', () => {
    expect(assertTransition(listingMachine, 'live', 'delist', { actor: staff }).to).toBe('delisted');
    expect(() => assertTransition(listingMachine, 'pushing', 'delist', { actor: staff })).toThrow(
      expect.objectContaining({ code: 'invalid_transition' }),
    );
    expect(() => assertTransition(listingMachine, 'live', 'delist', { actor: { ...staff, permissions: [] } })).toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });
});
