import { describe, expect, it } from 'vitest';
import { resolveRange, type StoredRow, sumFigures } from '#src/modules/report/domain/figures.ts';

const stored = (over: Partial<StoredRow> = {}): StoredRow => ({
  day: '2026-10-18',
  source: 'manual',
  shopId: null,
  revenue: '100000.00',
  cashCollected: '50000.00',
  platformFee: '0.00',
  paymentFee: '1100.00',
  shippingFee: '0.00',
  cogs: '60000.00',
  feesPending: false,
  ...over,
});

describe('sumFigures (AC-1, AC-2, AC-11, AC-12)', () => {
  it('cộng các dòng thành số nguyên đồng; lãi = doanh thu − giá vốn − các phí; feesPending là OR', () => {
    const f = sumFigures([stored(), stored({ source: 'marketplace', platformFee: '5000.00', shippingFee: '2000.00', feesPending: true })], true);
    expect(f).toEqual({
      revenue: 200000,
      cashCollected: 100000,
      platformFee: 5000,
      paymentFee: 2200,
      shippingFee: 2000,
      cogs: 120000,
      profit: 70800,
      feesPending: true,
    });
  });

  it('không có quyền giá vốn: cogs, profit là null', () => {
    expect(sumFigures([stored()], false)).toMatchObject({ revenue: 100000, cogs: null, profit: null });
  });

  it('không có dòng: mọi số 0, cogs/profit 0 hoặc null theo quyền', () => {
    expect(sumFigures([], true)).toEqual({
      revenue: 0,
      cashCollected: 0,
      platformFee: 0,
      paymentFee: 0,
      shippingFee: 0,
      cogs: 0,
      profit: 0,
      feesPending: false,
    });
    expect(sumFigures([], false)).toMatchObject({ cogs: null, profit: null });
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
