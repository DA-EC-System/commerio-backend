import { describe, expect, it } from 'vitest';
import {
  handoverStockMode,
  pickupUnconfirmed,
  type PlanLine,
  shipPlan,
  stockEffectOf,
} from '#src/modules/order/fulfillment/domain/handover.ts';
import type { PackageStatus } from '#src/modules/order/fulfillment/domain/package.ts';

describe('stockEffectOf: tác động tồn theo mũi tên (spec 199a §5.2)', () => {
  it.each<[PackageStatus | null, PackageStatus, 'ship' | 'reverse' | 'none']>([
    ['awaiting_pickup', 'in_transit', 'ship'],
    ['packed', 'self_delivering', 'ship'],
    ['reserved', 'delivered', 'ship'],
    ['backordered', 'in_transit', 'ship'],
    [null, 'in_transit', 'ship'],
    ['in_transit', 'delivered', 'none'],
    ['in_transit', 'awaiting_pickup', 'reverse'],
    ['reserved', 'packed', 'none'],
    [null, 'backordered', 'none'],
    ['returning', 'returned', 'none'],
  ])('%s → %s: %s', (from, to, effect) => {
    expect(stockEffectOf(from, to)).toBe(effect);
  });
});

describe('handoverStockMode: trừ, chỉ lưu hay hoãn theo mốc', () => {
  const cutoff = new Date('2026-11-01T00:00:00Z');
  const before = new Date(cutoff.getTime() - 1000);

  it('gian hàng chờ kiểm kê → defer, kể cả kiện lần đầu thấy trước mốc', () => {
    expect(handoverStockMode({ firstSeen: true, placedAt: before, orderCutoffAt: cutoff, awaitingStocktake: true })).toBe('defer');
  });

  it('kiện lần đầu thấy, đơn đặt 1 giây trước mốc → store_only', () => {
    expect(handoverStockMode({ firstSeen: true, placedAt: before, orderCutoffAt: cutoff, awaitingStocktake: false })).toBe('store_only');
  });

  it('kiện lần đầu thấy, đơn đặt đúng mốc → deduct', () => {
    expect(handoverStockMode({ firstSeen: true, placedAt: cutoff, orderCutoffAt: cutoff, awaitingStocktake: false })).toBe('deduct');
  });

  it('kiện đã có từ trước, đơn đặt trước mốc → deduct', () => {
    expect(handoverStockMode({ firstSeen: false, placedAt: before, orderCutoffAt: cutoff, awaitingStocktake: false })).toBe('deduct');
  });

  it('gian hàng chưa có mốc → deduct', () => {
    expect(handoverStockMode({ firstSeen: true, placedAt: before, orderCutoffAt: null, awaitingStocktake: false })).toBe('deduct');
  });
});

describe('shipPlan: dòng nào trừ', () => {
  const line = (p: Partial<PlanLine>): PlanLine => ({ id: 'l', variantId: 'v', quantity: 2, reservedQty: 2, stockDeducted: false, ...p });

  it('bỏ dòng chưa ghép SKU và dòng đã trừ; chia dòng đã giữ và chưa giữ', () => {
    const held = line({ id: 'held' });
    const unheld = line({ id: 'unheld', reservedQty: 0 });
    const plan = shipPlan([line({ id: 'unmapped', variantId: null, reservedQty: 0 }), line({ id: 'done', stockDeducted: true }), held, unheld]);
    expect(plan).toEqual({ held: [held], unheld: [unheld] });
  });

  it('không còn dòng nào để trừ → hai nhóm rỗng', () => {
    expect(shipPlan([line({ stockDeducted: true })])).toEqual({ held: [], unheld: [] });
  });
});

describe('pickupUnconfirmed: kho quét quá 24 giờ mà sàn chưa xác nhận', () => {
  const now = Date.parse('2026-11-09T12:00:00Z');
  const hoursAgo = (h: number, m = 0) => new Date(now - (h * 60 + m) * 60_000);
  const base = { status: 'in_transit' as PackageStatus, handoverSource: 'scan' as const, pickupConfirmedAt: null, handedOverAt: hoursAgo(24) };

  it('kho quét, chưa xác nhận, đúng 24 giờ → true', () => {
    expect(pickupUnconfirmed(base, now)).toBe(true);
  });

  it('mới 23 giờ 59 phút → false', () => {
    expect(pickupUnconfirmed({ ...base, handedOverAt: hoursAgo(23, 59) }, now)).toBe(false);
  });

  it('sàn đã xác nhận lấy → false', () => {
    expect(pickupUnconfirmed({ ...base, pickupConfirmedAt: hoursAgo(1) }, now)).toBe(false);
  });

  it('kiện do sàn báo bàn giao → false', () => {
    expect(pickupUnconfirmed({ ...base, handoverSource: 'marketplace' }, now)).toBe(false);
  });

  it('kiện đã về chờ lấy (huỷ bàn giao) → false', () => {
    expect(pickupUnconfirmed({ ...base, status: 'awaiting_pickup' }, now)).toBe(false);
  });
});
