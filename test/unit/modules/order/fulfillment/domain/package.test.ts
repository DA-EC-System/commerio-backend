import { describe, expect, it } from 'vitest';
import { platformUpdate } from '#src/modules/order/fulfillment/domain/package.ts';
import type { PackageStatus } from '#src/modules/order/fulfillment/domain/package.ts';

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
    ['reserved', 'lost'],
    ['delivered', 'returning'],
    ['in_transit', 'reserved'],
  ])('invalid: %s → %s', (from, to) => {
    expect(platformUpdate(from, to)).toBe('invalid');
  });
});
