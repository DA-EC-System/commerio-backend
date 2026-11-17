import { describe, expect, it } from 'vitest';
import { priceFilter, taxPctFor } from '#src/modules/channel/channel/domain/price-filter.ts';

// Bộ lọc giá theo gian hàng (#225, Documents/25 §6.2). Ví dụ A, B lấy từ 25 §6.2.
const shopA = { feePct: 14, perItemFee: 3000, roundStep: 10000, roundEnding: 9000 };
const shopB = { feePct: 9, perItemFee: 0, roundStep: 10000, roundEnding: 9000 };
const base = { target: '200000', taxPct: 0, cost: '150000', minMarginPct: 10 };

describe('priceFilter (25 §6.2)', () => {
  it('ví dụ sàn A: (200.000 + 3.000) / 0,86 = 236.046,5 → 239.000, thực nhận 202.540', () => {
    expect(priceFilter({ ...base, fee: shopA })).toEqual({
      ok: true,
      rawPrice: '236046.51',
      price: '239000',
      net: '202540',
      marginPct: '25.94',
      floor: '165000',
      belowFloor: false,
      totalPct: '14',
      feeWarning: null,
    });
  });

  it('ví dụ sàn B: 200.000 / 0,91 = 219.780,2 → 229.000, thực nhận 208.390', () => {
    expect(priceFilter({ ...base, fee: shopB })).toMatchObject({ ok: true, price: '229000', net: '208390', belowFloor: false });
  });

  it('ghi đè tay vẫn qua bước 5: A 195.000 → thực nhận 164.700 < giá thấp nhất 165.000', () => {
    expect(priceFilter({ ...base, fee: shopA, manualPrice: '195000' })).toMatchObject({ ok: true, price: '195000', net: '164700', belowFloor: true });
  });

  it('giá bù phí đúng bằng một bậc làm tròn thì giữ nguyên', () => {
    // 172.000 / (1 − 0,14) = 200.000 đúng bậc 1.000 đuôi 0.
    const r = priceFilter({ ...base, target: '172000', fee: { feePct: 14, perItemFee: 0, roundStep: 1000, roundEnding: 0 } });
    expect(r).toMatchObject({ ok: true, price: '200000' });
  });

  it('phần thuế cộng vào tổng phí: hộ kinh doanh 14% + 1,5%', () => {
    const r = priceFilter({ ...base, taxPct: 1.5, fee: { feePct: 14, perItemFee: 0, roundStep: 1000, roundEnding: 0 } });
    // 200.000 / 0,845 = 236.686,4 → 237.000
    expect(r).toMatchObject({ ok: true, price: '237000', totalPct: '15.5' });
  });

  it('không có giá vốn: không có giá thấp nhất, cờ null', () => {
    expect(priceFilter({ ...base, cost: null, fee: shopA })).toMatchObject({ ok: true, floor: null, belowFloor: null, marginPct: null });
  });

  it('tổng phí trên 50% thì cảnh báo; từ 100% trở lên thì lỗi cấu hình', () => {
    const fee = (feePct: number) => ({ ...shopB, feePct });
    expect(priceFilter({ ...base, fee: fee(50) })).toMatchObject({ ok: true, feeWarning: null });
    expect(priceFilter({ ...base, fee: fee(51) })).toMatchObject({ ok: true, feeWarning: 'over_50' });
    expect(priceFilter({ ...base, fee: fee(99), taxPct: 1 })).toEqual({ ok: false, error: 'fee_config_invalid' });
  });
});

describe('taxPctFor: phần thuế cộng vào tổng phí theo loại hình', () => {
  const rules = { vatPct: 1, pitPct: 0.5, outputVatPct: 10 };
  it('hộ kinh doanh, cá nhân: GTGT + TNCN sàn khấu trừ', () => {
    expect(taxPctFor({ regime: 'household' }, rules).toString()).toBe('1.5');
    expect(taxPctFor({ regime: 'individual' }, rules).toString()).toBe('1.5');
  });
  it('doanh nghiệp: v / (1 + v) của GTGT đầu ra, 10% → 9,0909…%', () => {
    expect(taxPctFor({ regime: 'company' }, rules).toFixed(4)).toBe('9.0909');
  });
  it('chưa có cấu hình thuế: 0', () => {
    expect(taxPctFor(undefined, rules).toString()).toBe('0');
    expect(taxPctFor({ regime: 'household' }, undefined).toString()).toBe('0');
  });
});
