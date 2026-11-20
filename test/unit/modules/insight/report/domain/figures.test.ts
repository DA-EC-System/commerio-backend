import { describe, expect, it } from 'vitest';
import { type DayRow, resolveRange, sourceOf, sumFigures } from '#src/modules/insight/report/domain/figures.ts';

const row = (over: Partial<DayRow> = {}): DayRow => ({
  day: '2026-10-18',
  shopId: 'shop-a',
  revenue: '100000.00',
  net: '80000.00',
  cogs: '-60000.00',
  cashCollected: '80000.00',
  platformFee: '-15000.00',
  shippingFee: '-5000.00',
  estimated: false,
  ...over,
});

describe('sumFigures (Documents/21 §21.5)', () => {
  it('cộng các dòng thành số nguyên đồng; lãi gộp = thực nhận + giá vốn; estimated là OR', () => {
    const f = sumFigures([row(), row({ cashCollected: '0', estimated: true })], true);
    expect(f).toEqual({
      revenue: 200000,
      net: 160000,
      cashCollected: 80000,
      platformFee: -30000,
      paymentFee: 0,
      shippingFee: -10000,
      cogs: -120000,
      profit: 40000,
      estimated: true,
      feesPending: true,
    });
  });

  it('không có quyền giá vốn: cogs, profit là null, thực nhận vẫn trả', () => {
    expect(sumFigures([row()], false)).toMatchObject({ revenue: 100000, net: 80000, cogs: null, profit: null });
  });

  it('không có dòng: mọi số 0, cogs/profit 0 hoặc null theo quyền', () => {
    expect(sumFigures([], true)).toEqual({
      revenue: 0,
      net: 0,
      cashCollected: 0,
      platformFee: 0,
      paymentFee: 0,
      shippingFee: 0,
      cogs: 0,
      profit: 0,
      estimated: false,
      feesPending: false,
    });
    expect(sumFigures([], false)).toMatchObject({ cogs: null, profit: null });
  });
});

describe('sourceOf', () => {
  it('có gian hàng là sàn, không có là ngoài sàn', () => {
    expect([sourceOf('shop-a'), sourceOf(null)]).toEqual(['marketplace', 'manual']);
  });
});

describe('resolveRange (AC-9, AC-15)', () => {
  const today = '2026-10-19';

  it('thiếu cả hai: 30 ngày tính tới hôm nay', () => {
    expect(resolveRange({}, today)).toEqual({ from: '2026-09-20', to: '2026-10-19' });
  });

  it('chỉ có to: from = to − 29; chỉ có from: to = hôm nay', () => {
    expect(resolveRange({ to: '2026-10-10' }, today)).toEqual({ from: '2026-09-11', to: '2026-10-10' });
    expect(resolveRange({ from: '2026-10-01' }, today)).toEqual({ from: '2026-10-01', to: '2026-10-19' });
  });

  it('to ở tương lai được nhận; 366 ngày được, 367 ngày báo errors.to', () => {
    expect(resolveRange({ from: '2026-10-01', to: '2026-12-31' }, today)).toEqual({ from: '2026-10-01', to: '2026-12-31' });
    expect(resolveRange({ from: '2028-01-01', to: '2028-12-31' }, today)).toEqual({ from: '2028-01-01', to: '2028-12-31' });
    expect(resolveRange({ from: '2026-01-01', to: '2027-01-02' }, today)).toEqual({ errors: { to: expect.any(String) } });
  });

  it('from sau to: errors.from; chỉ có from mà sau hôm nay: errors.from; chỉ có from quá 366 ngày: errors.to', () => {
    expect(resolveRange({ from: '2026-10-10', to: '2026-10-09' }, today)).toEqual({ errors: { from: expect.any(String) } });
    expect(resolveRange({ from: '2026-10-20' }, today)).toEqual({ errors: { from: expect.any(String) } });
    expect(resolveRange({ from: '2025-01-01' }, today)).toEqual({ errors: { to: expect.any(String) } });
  });
});
