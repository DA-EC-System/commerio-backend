import { describe, expect, it } from 'vitest';
import { assertTransition } from '#src/modules/core/index.ts';
import { listingMachine } from '#src/modules/channel/channel/domain/listing.ts';

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
