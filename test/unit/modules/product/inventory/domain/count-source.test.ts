import { describe, expect, it } from 'vitest';
import { countSourceOf } from '#src/modules/product/inventory/domain/count-source.ts';

// Nguồn số đếm của kiểm kê đầu kỳ (#569, Documents/21 §18.6.2 `StockDocLine.countSource`).
describe('countSourceOf', () => {
  const opening = { isOpening: true, platformStock: 4 };

  it('chưa đếm hoặc phiếu không phải đầu kỳ: null', () => {
    expect(countSourceOf({ ...opening, counted: null, requested: 'platform' })).toBeNull();
    expect(countSourceOf({ isOpening: false, counted: 4, requested: 'platform', platformStock: 4 })).toBeNull();
  });

  it('platform và số đếm bằng tồn sàn lúc ghi: platform', () => {
    expect(countSourceOf({ ...opening, counted: 4, requested: 'platform' })).toBe('platform');
  });

  it('platform mà số đếm khác tồn sàn, hoặc không có tồn sàn: manual (không báo lỗi)', () => {
    expect(countSourceOf({ ...opening, counted: 5, requested: 'platform' })).toBe('manual');
    expect(countSourceOf({ isOpening: true, counted: 0, requested: 'platform', platformStock: null })).toBe('manual');
  });

  it('thiếu hoặc manual: manual', () => {
    expect(countSourceOf({ ...opening, counted: 4, requested: undefined })).toBe('manual');
    expect(countSourceOf({ ...opening, counted: 4, requested: null })).toBe('manual');
    expect(countSourceOf({ ...opening, counted: 4, requested: 'manual' })).toBe('manual');
  });
});
