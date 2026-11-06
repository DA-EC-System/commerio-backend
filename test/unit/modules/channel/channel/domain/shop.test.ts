import { describe, expect, it } from 'vitest';
import { assertTransition } from '#src/modules/core/index.ts';
import {
  assertNoOpenOrders,
  reconnectAction,
  returnWindowError,
  shopMachine,
  tokenExpiringSoon,
} from '#src/modules/channel/channel/domain/shop.ts';

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

  it('mất uỷ quyền đi từ connecting, active (§18.1), chỉ do hệ thống chuyển', () => {
    for (const from of ['connecting', 'active'] as const) {
      expect(assertTransition(shopMachine, from, 'lose_auth', { actor: null }).to).toBe('needs_reauth');
    }
    for (const from of ['needs_reauth', 'disconnected'] as const) {
      expect(() => assertTransition(shopMachine, from, 'lose_auth', { actor: null })).toThrow(
        expect.objectContaining({ status: 409, code: 'invalid_transition' }),
      );
    }
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

  it('chưa thiết lập (chưa có mốc lấy đơn) thì về connecting, còn lại về active', () => {
    expect(reconnectAction('disconnected', null)).toBe('resume_setup');
    expect(reconnectAction('needs_reauth', null)).toBe('resume_setup');
    expect(assertTransition(shopMachine, 'needs_reauth', 'resume_setup', { actor: admin }).to).toBe('connecting');
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

describe('chặn ngắt khi còn đơn chưa xong (#207)', () => {
  it('không còn đơn mở thì qua', () => {
    expect(() => assertNoOpenOrders(0)).not.toThrow();
  });

  it('còn đơn mở thì 409 shop_has_open_orders kèm openOrders', () => {
    expect(() => assertNoOpenOrders(5)).toThrow(
      expect.objectContaining({ status: 409, code: 'shop_has_open_orders', extensions: { openOrders: 5 } }),
    );
  });
});

describe('hạn trả hàng nhập lúc thiết lập (Documents/21 §18.6.2)', () => {
  it('sàn tính hạn theo ngày: số nguyên 1–60 hợp lệ, ngoài khoảng hoặc lẻ thì báo lỗi', () => {
    for (const ok of [1, 14, 60]) expect(returnWindowError('days', ok)).toBeNull();
    for (const bad of [0, 61, -1, 1.5, 1e10]) expect(returnWindowError('days', bad)).toBe('Hạn trả hàng từ 1 đến 60 ngày');
  });

  it('chuyển tiếp đợt 2: không gửi (undefined, null) thì không lỗi', () => {
    expect(returnWindowError('days', undefined)).toBeNull();
    expect(returnWindowError('days', null)).toBeNull();
  });

  it('sàn tính hạn theo trạng thái sàn: bỏ qua trường này', () => {
    expect(returnWindowError('platform_status', 0)).toBeNull();
    expect(returnWindowError('platform_status', 999)).toBeNull();
  });
});
