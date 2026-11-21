import { describe, expect, it } from 'vitest';
import { type FeeSample, feeSamplesFromLines, suggestFeeConfig } from '#src/modules/finance/finance/domain/fee-suggestion.ts';

// Gợi ý cấu hình phí từ phí thực tế của các đơn đã quyết toán (.claude/issues/luong-san-pham/tra-phi-san.md mục 5b).
const sample = (over: Partial<FeeSample> & { fees?: FeeSample['fees'] }): FeeSample => ({
  externalOrderId: 'O',
  date: '2026-11-20',
  commissionBase: '100000',
  transactionBase: null,
  itemCount: 1,
  fees: {},
  estimated: false,
  ...over,
});

describe('suggestFeeConfig', () => {
  it('tỷ lệ tính trên tổng cả lô (không trung bình từng đơn); phí giao dịch dùng transactionBase khi có', () => {
    const s = suggestFeeConfig([
      sample({ externalOrderId: 'A', commissionBase: '100000', transactionBase: '110000', fees: { fee_fixed: '14000', fee_transaction: '6600' } }),
      sample({ externalOrderId: 'B', commissionBase: '300000', transactionBase: '300000', fees: { fee_fixed: '42000', fee_transaction: '18000' } }),
    ])!;
    expect(s.fixedPct).toBe(14);
    // (6600 + 18000) / (110000 + 300000) = 6%.
    expect(s.transactionPct).toBe(6);
    expect(s.sampleCount).toBe(2);
  });

  it('fee_service: trung vị mỗi đơn là phí cố định (chia số món trung bình), phần vượt thành servicePct', () => {
    const s = suggestFeeConfig([
      sample({ externalOrderId: 'A', fees: { fee_service: '3000' } }),
      sample({ externalOrderId: 'B', fees: { fee_service: '3000' } }),
      sample({ externalOrderId: 'C', fees: { fee_service: '5000' }, itemCount: 2 }),
    ])!;
    // Trung vị 3000; số món trung bình (1 + 1 + 2) / 3 = 4/3 → 2250 mỗi món; phần vượt 2000 / 300000 = 0,67%.
    expect(s.perItemFee).toBe(2250);
    expect(s.servicePct).toBe(0.67);
  });

  it('độ phân tán: hoa hồng từng đơn lệch quá 1 điểm % thì cảnh báo bán nhiều ngành; có p10, p90, stdev', () => {
    const s = suggestFeeConfig([
      sample({ externalOrderId: 'A', fees: { fee_fixed: '14000' } }),
      sample({ externalOrderId: 'B', fees: { fee_fixed: '10000' } }),
      sample({ externalOrderId: 'C', fees: { fee_fixed: '12000' } }),
    ])!;
    expect(s.spread.fee_fixed.p10).toBeCloseTo(10.4, 1);
    expect(s.spread.fee_fixed.p90).toBeCloseTo(13.6, 1);
    expect(s.spread.fee_fixed.stdev).toBeGreaterThan(1);
    expect(s.warnings.some((w) => w.includes('nhiều ngành'))).toBe(true);
  });

  it('lấy n mẫu mới nhất theo ngày; báo số ước tính và khi ít hơn n; bỏ mẫu cơ sở không dương; không mẫu thì null', () => {
    const s = suggestFeeConfig(
      [
        sample({ externalOrderId: 'old', date: '2026-10-01', fees: { fee_fixed: '50000' } }),
        sample({ externalOrderId: 'new', date: '2026-11-20', fees: { fee_fixed: '14000' }, estimated: true }),
        sample({ externalOrderId: 'zero', date: '2026-11-21', commissionBase: '0', fees: { fee_fixed: '1' } }),
      ],
      1,
    )!;
    expect(s.sampleCount).toBe(1);
    expect(s.fixedPct).toBe(14);
    expect(s.estimatedCount).toBe(1);
    expect(s.warnings.some((w) => w.includes('ước tính'))).toBe(true);
    expect(suggestFeeConfig([sample({ commissionBase: '0' })])).toBeNull();
    expect(suggestFeeConfig([sample({})], 30)!.warnings.some((w) => w.includes('ít hơn 30'))).toBe(true);
  });

  it('phí ghi âm hay dương đều tính theo độ lớn', () => {
    const s = suggestFeeConfig([sample({ fees: { fee_fixed: '-14000', fee_optional: '5000' } })])!;
    expect(s.fixedPct).toBe(14);
    expect(s.optionalPct).toBe(5);
  });
});

describe('feeSamplesFromLines (sàn chỉ có dòng theo khoản, vd Lazada)', () => {
  it('gom theo đơn: cơ sở là dòng doanh thu, phí theo kind; bỏ đơn có hoàn tiền, dòng không đơn hay không kind', () => {
    const samples = feeSamplesFromLines([
      { externalOrderId: 'A', date: '2026-11-19', amount: '200000', kind: 'revenue' },
      { externalOrderId: 'A', date: '2026-11-20', amount: '-28000', kind: 'fee_fixed' },
      { externalOrderId: 'A', date: '2026-11-20', amount: '-4000', kind: 'fee_transaction' },
      { externalOrderId: 'A', date: '2026-11-20', amount: '-1000', kind: 'fee_transaction' },
      { externalOrderId: 'B', date: '2026-11-20', amount: '100000', kind: 'revenue' },
      { externalOrderId: 'B', date: '2026-11-20', amount: '-100000', kind: 'customer_refund' },
      { externalOrderId: null, date: '2026-11-20', amount: '-5000', kind: 'penalty' },
      { externalOrderId: 'A', date: '2026-11-20', amount: '-7', kind: null },
    ]);
    expect(samples).toEqual([
      {
        externalOrderId: 'A',
        date: '2026-11-20',
        commissionBase: '200000',
        transactionBase: null,
        itemCount: null,
        fees: { fee_fixed: '28000', fee_transaction: '5000' },
        estimated: false,
      },
    ]);
  });
});
