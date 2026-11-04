import { describe, expect, it } from 'vitest';
import {
  breaksInvariant,
  isBelowMin,
  nextAlertState,
  stockState,
  stockValue,
  toDong,
  weightedAvgCost,
  worsens,
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

describe('giá vốn khi tồn ≤ 0 (spec #111 Q5)', () => {
  it('tồn âm hoặc bằng 0 thì giá vốn mới bằng giá nhập', () => {
    expect(weightedAvgCost(-3, '80000', 5, '50000').toFixed(2)).toBe('50000.00');
    expect(weightedAvgCost(0, '0', 5, '100000').toFixed(2)).toBe('100000.00');
  });

  it('tồn dương vẫn bình quân gia quyền', () => {
    expect(weightedAvgCost(10, '80000', 5, '100000').toFixed(2)).toBe('86666.67');
  });
});

describe('không làm tệ hơn (spec #111 Q6)', () => {
  it('chặn khi tồn thực giảm mà kết quả vỡ bất biến', () => {
    expect(worsens({ onHand: 2 }, { onHand: -1, reserved: 0 })).toBe(true);
    expect(worsens({ onHand: 5 }, { onHand: 3, reserved: 4 })).toBe(true);
  });

  it('cho qua khi tồn thực tăng, kể cả khi vẫn còn âm', () => {
    expect(worsens({ onHand: -3 }, { onHand: -1, reserved: 0 })).toBe(false);
    expect(worsens({ onHand: -3 }, { onHand: 2, reserved: 0 })).toBe(false);
  });

  it('cho qua khi giảm mà bất biến vẫn đúng', () => {
    expect(worsens({ onHand: 5 }, { onHand: 3, reserved: 3 })).toBe(false);
  });

  it('breaksInvariant: âm, hoặc đang giữ > tồn thực', () => {
    expect([breaksInvariant(-1, 0), breaksInvariant(2, 3), breaksInvariant(2, 2)]).toEqual([true, true, false]);
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

describe('dưới ngưỡng (Documents/25 mục 7.5, Documents/21 mục 15.1)', () => {
  const base = { available: 3, incoming: 0, shortage: 0, minQty: 5, businessStatus: 'selling' as const };

  it('có thể bán + đang về − còn thiếu cho đơn ≤ ngưỡng; bằng ngưỡng cũng là dưới', () => {
    expect(isBelowMin(base)).toBe(true);
    expect(isBelowMin({ ...base, available: 5 })).toBe(true);
    expect(isBelowMin({ ...base, available: 6 })).toBe(false);
  });

  it('tính cả đang về và còn thiếu cho đơn', () => {
    expect(isBelowMin({ ...base, incoming: 3 })).toBe(false);
    expect(isBelowMin({ ...base, available: 6, shortage: 1 })).toBe(true);
  });

  it('chưa đặt ngưỡng, hoặc SKU ngừng bán, lưu trữ thì không dưới ngưỡng', () => {
    expect(isBelowMin({ ...base, minQty: null })).toBe(false);
    expect(isBelowMin({ ...base, businessStatus: 'discontinued' })).toBe(false);
    expect(isBelowMin({ ...base, businessStatus: 'archived' })).toBe(false);
    expect(isBelowMin({ ...base, businessStatus: 'paused' })).toBe(true);
  });

  it('state: hết hàng khi có thể bán ≤ 0, sắp hết khi 0 < có thể bán ≤ ngưỡng, còn lại còn hàng (Documents/25 mục 7.2)', () => {
    expect(stockState(0, 5)).toBe('out');
    expect(stockState(0, null)).toBe('out');
    expect(stockState(4, 5)).toBe('low');
    expect(stockState(5, 5)).toBe('low');
    expect(stockState(6, 5)).toBe('in_stock');
    expect(stockState(3, null)).toBe('in_stock');
  });
});

describe('chuyển trạng thái cảnh báo ngưỡng (V31, Documents/25 mục 7.5)', () => {
  const at = (available: number, minQty: number | null, alertActive: boolean) => ({
    available,
    incoming: 0,
    shortage: 0,
    minQty,
    businessStatus: 'selling' as const,
    alertActive,
  });
  const cases = [
    { name: 'vừa chạm ngưỡng: bật cảnh báo và phát', in: at(5, 5, false), out: { alertActive: true, fire: true } },
    { name: 'xuống tiếp khi đã cảnh báo: không phát lại', in: at(3, 5, true), out: { alertActive: true, fire: false } },
    { name: 'lên lại trên ngưỡng: tắt cảnh báo', in: at(6, 5, true), out: { alertActive: false, fire: false } },
    { name: 'trên ngưỡng, chưa cảnh báo: giữ nguyên', in: at(9, 5, false), out: { alertActive: false, fire: false } },
    { name: 'bỏ ngưỡng: tắt cảnh báo, không phát', in: at(0, null, true), out: { alertActive: false, fire: false } },
    { name: 'ngưỡng 0: chỉ báo khi không còn gì', in: at(0, 0, false), out: { alertActive: true, fire: true } },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(nextAlertState(c.in)).toEqual(c.out);
    });
  }
});
