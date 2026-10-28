import { describe, expect, it } from 'vitest';
import { assertTransition } from '#src/modules/core/index.ts';
import { reconnectAction, shopMachine, tokenExpiringSoon } from '#src/modules/channel/channel/domain/shop.ts';

const NOW = Date.parse('2026-10-28T00:00:00Z');
const DAY = 24 * 3600_000;
const admin = {
  accountId: 'a',
  permissions: ['channel.shop.connect', 'channel.shop.disconnect'],
  enabledModules: ['channel'],
};

describe('máy trạng thái gian hàng', () => {
  it('ngắt được từ connecting, active, needs_reauth; đã ngắt thì 409', () => {
    for (const from of ['connecting', 'active', 'needs_reauth'] as const) {
      expect(assertTransition(shopMachine, from, 'disconnect', { actor: admin }).to).toBe('disconnected');
    }
    expect(() => assertTransition(shopMachine, 'disconnected', 'disconnect', { actor: admin })).toThrow(
      expect.objectContaining({ status: 409, code: 'invalid_transition' }),
    );
  });

  it('mất uỷ quyền chỉ do hệ thống chuyển', () => {
    expect(assertTransition(shopMachine, 'active', 'lose_auth', { actor: null }).to).toBe('needs_reauth');
    expect(() => assertTransition(shopMachine, 'active', 'lose_auth', { actor: admin })).toThrow(
      expect.objectContaining({ code: 'invalid_transition' }),
    );
  });

  it('ngắt cần quyền channel.shop.disconnect', () => {
    const sale = { ...admin, permissions: ['channel.shop.connect'] };
    expect(() => assertTransition(shopMachine, 'active', 'disconnect', { actor: sale })).toThrow(
      expect.objectContaining({ status: 403, code: 'forbidden' }),
    );
  });
});

describe('reconnectAction', () => {
  it('đang connecting hoặc active thì chỉ thay token', () => {
    expect(reconnectAction('connecting', null)).toBeNull();
    expect(reconnectAction('active', new Date(NOW))).toBeNull();
  });

  it('đã ngắt khi chưa thiết lập thì về connecting, còn lại về active', () => {
    expect(reconnectAction('disconnected', null)).toBe('resume_setup');
    expect(reconnectAction('disconnected', new Date(NOW))).toBe('reconnect');
    expect(reconnectAction('needs_reauth', new Date(NOW))).toBe('reconnect');
  });
});

describe('tokenExpiringSoon', () => {
  it('bật khi refresh token còn dưới 3 ngày và gian hàng đang active', () => {
    expect(tokenExpiringSoon('active', new Date(NOW + 2 * DAY), NOW)).toBe(true);
    expect(tokenExpiringSoon('active', new Date(NOW + 4 * DAY), NOW)).toBe(false);
    expect(tokenExpiringSoon('needs_reauth', new Date(NOW + DAY), NOW)).toBe(false);
    expect(tokenExpiringSoon('active', null, NOW)).toBe(false);
  });
});
