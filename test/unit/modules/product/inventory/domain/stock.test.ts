import { describe, expect, it } from 'vitest';
import {
  isBelowMin,
  nextAlertState,
  stockValue,
  toDong,
  weightedAvgCost,
} from '#src/modules/product/inventory/domain/stock.ts';

// Luật thuần của kho (plan #16 lát 1): giá vốn bình quân (K2, QT-15), làm tròn (V29, V30), ngưỡng (K7, V31), số phiếu (V32).
describe('giá vốn bình quân gia quyền', () => {
  it('nhập 5 × 130.000 vào 10 cái giá 100.000 ra 110.000 (AC-5)', () => {
    expect(weightedAvgCost(10, '100000.00', 5, 130000).toFixed(2)).toBe('110000.00');
  });

  it('làm tròn nửa lên 2 chữ số: 3 × 100.000 + 2 × 100.001 ra 100000.40 (AC-17)', () => {
    expect(weightedAvgCost(3, '100000.00', 2, 100001).toFixed(2)).toBe('100000.40');
  });

  it('làm tròn nửa lên khi đúng nửa xu', () => {
    // (1 × 0 + 1 × 0.01) / 2 = 0.005 → 0.01
    expect(weightedAvgCost(1, '0', 1, '0.01').toFixed(2)).toBe('0.01');
  });

  it('kho đang trống thì giá vốn là giá nhập, bỏ qua giá vốn cũ', () => {
    expect(weightedAvgCost(0, '90000.00', 4, 120000).toFixed(2)).toBe('120000.00');
  });

  it('từ chối số lượng nhập không dương', () => {
    expect(() => weightedAvgCost(10, '100000', 0, 1)).toThrow();
  });
});

describe('đổi ra số nguyên đồng cho API (V29)', () => {
  it('100000.40 ra 100000, 100000.50 ra 100001', () => {
    expect(toDong('100000.40')).toBe(100000);
    expect(toDong('100000.50')).toBe(100001);
  });

  it('nhận chuỗi numeric của node-pg', () => {
    expect(toDong('110000.00')).toBe(110000);
  });
});

describe('giá trị tồn (V30, A4)', () => {
  it('tính từ giá vốn 2 chữ số của DB rồi làm tròn đồng: 5 × 100000.40 = 500002', () => {
    expect(stockValue(5, '100000.40')).toBe(500002);
  });

  it('tồn 0 thì giá trị 0', () => {
    expect(stockValue(0, '100000.40')).toBe(0);
  });

  it('làm tròn trên tích, không trên giá vốn: 3 × 0.50 = 1.5 ra 2', () => {
    expect(stockValue(3, '0.50')).toBe(2);
  });
});

describe('dưới ngưỡng (K7)', () => {
  it('belowMin khi khả dụng nhỏ hơn ngưỡng; chưa đặt ngưỡng thì không', () => {
    expect(isBelowMin(4, 5)).toBe(true);
    expect(isBelowMin(5, 5)).toBe(false);
    expect(isBelowMin(0, null)).toBe(false);
  });
});

describe('chuyển trạng thái cảnh báo ngưỡng (V31, AC-18)', () => {
  const cases = [
    { name: 'vừa xuống dưới ngưỡng: bật cảnh báo và phát', in: { available: 4, minQty: 5, alertActive: false }, out: { alertActive: true, fire: true } },
    { name: 'xuống tiếp khi đã cảnh báo: không phát lại', in: { available: 3, minQty: 5, alertActive: true }, out: { alertActive: true, fire: false } },
    { name: 'lên lại bằng ngưỡng: tắt cảnh báo', in: { available: 5, minQty: 5, alertActive: true }, out: { alertActive: false, fire: false } },
    { name: 'trên ngưỡng, chưa cảnh báo: giữ nguyên', in: { available: 9, minQty: 5, alertActive: false }, out: { alertActive: false, fire: false } },
    { name: 'bỏ ngưỡng: tắt cảnh báo, không phát', in: { available: 0, minQty: null, alertActive: true }, out: { alertActive: false, fire: false } },
    { name: 'ngưỡng 0 không bao giờ cảnh báo', in: { available: 0, minQty: 0, alertActive: false }, out: { alertActive: false, fire: false } },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(nextAlertState(c.in)).toEqual(c.out);
    });
  }
});
