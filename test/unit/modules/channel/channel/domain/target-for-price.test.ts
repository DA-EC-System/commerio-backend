import { describe, expect, it } from 'vitest';
import { priceFilter, targetForPrice } from '#src/modules/channel/channel/domain/price-filter.ts';

// Giá muốn bán tính ngược từ giá niêm yết trên sàn (#500): chạy lại bộ lọc với số tính ra phải ra đúng giá sàn.
const run = (target: string, fee: Parameters<typeof targetForPrice>[1], taxPct: number) => {
  const r = priceFilter({ target, fee, taxPct, cost: null, minMarginPct: 0 });
  return r.ok ? r.price : null;
};

describe('targetForPrice', () => {
  it.each([
    ['sàn A (14%, 3.000, bậc 10.000 đuôi 9.000)', '239000', { feePct: 14, perItemFee: 3000, roundStep: 10000, roundEnding: 9000 }, 0],
    ['phí lẻ, thuế hộ kinh doanh, bậc 1 đồng', '61300', { feePct: '9.2', perItemFee: 0, roundStep: 1, roundEnding: 0 }, 1.5],
    ['phí cao, bậc 1 đồng (1/(1 − %) > 1)', '99999', { feePct: 49, perItemFee: 1234, roundStep: 1, roundEnding: 0 }, 0.9],
    ['bậc 1.000', '125000', { feePct: '4.15', perItemFee: 0, roundStep: 1000, roundEnding: 0 }, 0],
  ])('%s: bộ lọc ra đúng giá sàn', (_name, price, fee, tax) => {
    const target = targetForPrice(price, fee, tax);
    expect(target).not.toBeNull();
    expect(run(target!, fee, tax)).toBe(price);
    // Số lớn nhất còn ra đúng giá: thêm một đồng thì giá đổi.
    expect(run(String(Number(target) + 1), fee, tax)).not.toBe(price);
  });

  it('ví dụ sàn A: (202.540 + 3.000) / 0,86 = 239.000', () => {
    expect(targetForPrice('239000', { feePct: 14, perItemFee: 3000, roundStep: 10000, roundEnding: 9000 }, 0)).toBe('202540');
  });

  it('giá sàn không nằm trên lưới làm tròn: lấy số nhỏ nhất cho giá ≥ giá sàn', () => {
    const fee = { feePct: 10, perItemFee: 0, roundStep: 10000, roundEnding: 9000 };
    const target = targetForPrice('61300', fee, 0)!;
    expect(run(target, fee, 0)).toBe('69000');
    expect(run(String(Number(target) - 1), fee, 0)).toBe('59000');
  });

  it('thực nhận ≤ 0 hoặc tổng % không hợp lệ: null', () => {
    expect(targetForPrice('1000', { feePct: 10, perItemFee: 5000, roundStep: 1, roundEnding: 0 }, 0)).toBeNull();
    expect(targetForPrice('100000', { feePct: 100, perItemFee: 0, roundStep: 1, roundEnding: 0 }, 0)).toBeNull();
  });
});

describe('targetForPrice: quét nhiều giá', () => {
  it.each([
    [{ feePct: '9.2', perItemFee: 0, roundStep: 1, roundEnding: 0 }, 1.5],
    [{ feePct: '27.35', perItemFee: 2500, roundStep: 1, roundEnding: 0 }, '9.0909'],
    [{ feePct: 12, perItemFee: 0, roundStep: 100, roundEnding: 0 }, 0],
  ])('mọi giá trên lưới làm tròn đều ra đúng (%o, thuế %s)', (fee, tax) => {
    for (let p = 30000; p <= 32000; p += fee.roundStep) {
      const target = targetForPrice(String(p), fee, tax);
      expect(run(target!, fee, Number(tax)), `giá ${p}`).toBe(String(p));
    }
  });
});
