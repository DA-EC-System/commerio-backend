import { describe, expect, it } from 'vitest';
import {
  type DeliveredLine,
  type PackageEvent,
  deliveredAmounts,
  deliveryTarget,
  eventsOf,
  journeyTimes,
  lineStatus,
} from '#src/modules/order/fulfillment/domain/delivery.ts';
import type { PlatformLineStatus } from '#src/modules/order/fulfillment/domain/delivery.ts';

const ev = (status: PlatformLineStatus, at: string, extra: Partial<PackageEvent> = {}): PackageEvent => ({
  packageCode: 'FP-1',
  trackingCode: 'TN-1',
  status,
  at: new Date(at),
  description: null,
  ...extra,
});
const NOW = '2026-11-10T10:00:00Z';

describe('lineStatus: món huỷ vì giao không thành sang đang hoàn (D2, spec 199c §5.2)', () => {
  it('cancelled + cancelKind failed_delivery → returning', () => {
    expect(lineStatus({ status: 'cancelled', cancelKind: 'failed_delivery' })).toBe('returning');
  });
  it('cancelled + cancelKind cancellation → cancelled (giữ nguyên)', () => {
    expect(lineStatus({ status: 'cancelled', cancelKind: 'cancellation' })).toBe('cancelled');
  });
  it('trạng thái không phải cancelled giữ nguyên, kể cả không có cancelKind', () => {
    expect(lineStatus({ status: 'delivered' })).toBe('delivered');
    expect(lineStatus({ status: 'in_transit' })).toBe('in_transit');
  });
  it('status null → null', () => {
    expect(lineStatus({ status: null })).toBeNull();
  });
});

describe('deliveryTarget: đích kiện của trạng thái sàn (D1, D9, spec 199c §5.2)', () => {
  it('returned: firstSeen + storeOnly → returned (D9), còn lại returning (D1)', () => {
    expect(deliveryTarget('returned', { firstSeen: true, storeOnly: true })).toBe('returned');
    expect(deliveryTarget('returned', { firstSeen: true, storeOnly: false })).toBe('returning');
    expect(deliveryTarget('returned', { firstSeen: false, storeOnly: true })).toBe('returning');
  });
  it('return_failed → returning', () => {
    expect(deliveryTarget('return_failed', { firstSeen: false, storeOnly: false })).toBe('returning');
    expect(deliveryTarget('return_failed', { firstSeen: true, storeOnly: true })).toBe('returning');
  });
  it('delivered, in_transit, delivery_failed, returning, lost giữ trạng thái cùng tên', () => {
    expect(deliveryTarget('delivered', { firstSeen: false, storeOnly: false })).toBe('delivered');
    expect(deliveryTarget('in_transit', { firstSeen: false, storeOnly: false })).toBe('in_transit');
    expect(deliveryTarget('delivery_failed', { firstSeen: false, storeOnly: false })).toBe('delivery_failed');
    expect(deliveryTarget('returning', { firstSeen: false, storeOnly: false })).toBe('returning');
    expect(deliveryTarget('lost', { firstSeen: false, storeOnly: false })).toBe('lost');
  });
});

describe('eventsOf: lọc sự kiện hành trình đúng kiện (spec 199c §5.2)', () => {
  it('mỗi kiện chỉ nhận sự kiện trùng mã kiện sàn của mình', () => {
    const e1 = ev('in_transit', '2026-11-10T08:00:00Z', { packageCode: 'FP-1' });
    const e2 = ev('delivered', '2026-11-10T09:00:00Z', { packageCode: 'FP-2' });
    expect(eventsOf([e1, e2], { platformPackageCode: 'FP-1', trackingCode: null })).toEqual([e1]);
    expect(eventsOf([e1, e2], { platformPackageCode: 'FP-2', trackingCode: null })).toEqual([e2]);
  });

  it('không có sự kiện trùng mã kiện thì khớp theo mã vận đơn', () => {
    const e = ev('delivered', '2026-11-10T09:00:00Z', { packageCode: null, trackingCode: 'TN-1' });
    expect(eventsOf([e], { platformPackageCode: 'FP-X', trackingCode: 'TN-1' })).toEqual([e]);
  });

  it('mã kiện và mã vận đơn đều null → không khớp theo mã đó, trả []', () => {
    const e = ev('delivered', '2026-11-10T09:00:00Z');
    expect(eventsOf([e], { platformPackageCode: null, trackingCode: null })).toEqual([]);
    // Sự kiện không trùng mã kiện, kiện không có mã vận đơn để dự phòng → [].
    expect(eventsOf([ev('delivered', '2026-11-10T09:00:00Z', { packageCode: 'FP-2', trackingCode: null })], { platformPackageCode: 'FP-1', trackingCode: null })).toEqual([]);
  });
});

describe('journeyTimes: mốc rời kho, giao, lý do thất bại từ hành trình (spec 199c §5.2)', () => {
  const now = new Date(NOW);

  it('rời kho = mốc sớm nhất, giao = mốc muộn nhất của delivered', () => {
    const events = [ev('in_transit', '2026-11-10T08:00:00Z'), ev('delivered', '2026-11-10T09:00:00Z'), ev('delivered', '2026-11-10T09:30:00Z')];
    expect(journeyTimes(events, now).leftAt).toEqual(new Date('2026-11-10T08:00:00Z'));
    expect(journeyTimes(events, now).deliveredAt).toEqual(new Date('2026-11-10T09:30:00Z'));
  });

  it('lý do thất bại = mô tả sự kiện delivery_failed muộn nhất, cắt khoảng trắng', () => {
    const events = [
      ev('delivery_failed', '2026-11-10T08:00:00Z', { description: 'Lần một' }),
      ev('delivery_failed', '2026-11-10T09:00:00Z', { description: '  Khách không nghe máy ' }),
    ];
    expect(journeyTimes(events, now).failReason).toBe('Khách không nghe máy');
  });

  it('mô tả chỉ khoảng trắng → null', () => {
    const events = [ev('delivery_failed', '2026-11-10T09:00:00Z', { description: '   ' })];
    expect(journeyTimes(events, now).failReason).toBeNull();
  });

  it('mốc sau giờ đồng bộ thì lấy giờ đồng bộ', () => {
    const events = [ev('delivered', '2026-11-10T11:00:00Z')];
    expect(journeyTimes(events, now).deliveredAt).toEqual(now);
  });

  it('không sự kiện → cả ba null', () => {
    expect(journeyTimes([], now)).toEqual({ leftAt: null, deliveredAt: null, failReason: null });
  });
});

describe('deliveredAmounts: tiền kiện giao xong (D4, D10, Review Focus 4–5, spec 199c §5.2)', () => {
  const line = (patch: Partial<DeliveredLine> = {}): DeliveredLine => ({
    variantId: 'v1',
    quantity: 1,
    unitCost: '60000.00',
    order: { quantity: 1, unitPrice: '100000.00', sellerDiscount: '10000.00', platformDiscount: '5000.00' },
    ...patch,
  });
  const ship = { shippingFee: '15000.00', shippingFeeOriginal: '30000.00', shippingFeeDiscountPlatform: '12000.00' };

  it('kiện đầu: unitPrice sau voucher shop, platformSubsidy = voucher + trợ ship sàn, ship cấp đơn', () => {
    const r = deliveredAmounts([line()], ship, true);
    expect(r.lines[0]!.unitPrice).toBe('90000.00');
    expect(r.lines[0]!.unitCost).toBe('60000.00');
    expect(r.platformSubsidy).toBe('17000.00');
    expect(r.shippingIncome).toBe('15000.00');
    expect(r.shippingCost).toBe('30000.00');
  });

  it('kiện sau: platformSubsidy chỉ voucher, ship "0.00"', () => {
    const r = deliveredAmounts([line()], ship, false);
    expect(r.platformSubsidy).toBe('5000.00');
    expect(r.shippingIncome).toBe('0.00');
    expect(r.shippingCost).toBe('0.00');
  });

  it('Review Focus 4: dòng kiện một phần dòng đơn, voucher chia theo tỉ lệ số lượng', () => {
    const l = line({ quantity: 2, order: { quantity: 4, unitPrice: '50000.00', sellerDiscount: '20000.00', platformDiscount: '8000.00' } });
    const r = deliveredAmounts([l], { shippingFee: '15000.00', shippingFeeOriginal: null, shippingFeeDiscountPlatform: null }, false);
    expect(r.lines[0]!.unitPrice).toBe('45000.00');
    expect(r.platformSubsidy).toBe('4000.00');
  });

  it('Review Focus 5: đơn trước #260 thiếu original/discount_platform → shipCost = shippingFee, trợ ship 0', () => {
    const r = deliveredAmounts([line()], { shippingFee: '15000.00', shippingFeeOriginal: null, shippingFeeDiscountPlatform: null }, true);
    expect(r.shippingCost).toBe('15000.00');
    expect(r.shippingIncome).toBe('15000.00');
    // Voucher sàn của dòng: 5000, không có trợ ship.
    expect(r.platformSubsidy).toBe('5000.00');
  });

  it('làm tròn HALF_UP 2 chữ số', () => {
    const l = line({ order: { quantity: 3, unitPrice: '100000.00', sellerDiscount: '10000.00', platformDiscount: '0.00' } });
    expect(deliveredAmounts([l], ship, false).lines[0]!.unitPrice).toBe('96666.67');
  });

  it('dòng chưa ghép SKU giữ variantId, unitCost null, unitPrice vẫn đủ', () => {
    const l = line({ variantId: null, unitCost: null });
    const r = deliveredAmounts([l], ship, true);
    expect(r.lines[0]).toEqual({ variantId: null, quantity: 1, unitPrice: '90000.00', unitCost: null });
  });
});
