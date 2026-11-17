import { describe, expect, it } from 'vitest';
import { suggestFromSiblings, suggestMinQty, suggestTargetPrice } from '#src/modules/product/catalog/domain/suggestion.ts';

// Gợi ý khi sửa hàng loạt (#242, 27 US-SP-04 AC 2, 3, 4).
describe('suggestTargetPrice', () => {
  it('AC2: giá nhập 100.000, hệ số 1,4 → 140.000', () => {
    expect(suggestTargetPrice(100_000, { marginCoefficient: 1.4, priceRounding: null }, true).value).toBe(140_000);
  });

  it('làm tròn LÊN theo bước của danh mục: 205.000 × 1,6 = 328.000; 123.456 × 1,3 = 160.492,8 → 161.000', () => {
    expect(suggestTargetPrice('205000.00', { marginCoefficient: 1.6, priceRounding: 1000 }, true).value).toBe(328_000);
    expect(suggestTargetPrice(123_456, { marginCoefficient: 1.3, priceRounding: 1000 }, true).value).toBe(161_000);
  });

  it('không dính lỗi số thực: 0,1 + 0,2 kiểu số học nhị phân không đẩy giá lên một bước', () => {
    expect(suggestTargetPrice(10_000, { marginCoefficient: 1.1, priceRounding: 100 }, true).value).toBe(11_000);
  });

  it('câu giải thích nêu giá nhập khi được xem, không nêu khi thiếu quyền xem giá vốn', () => {
    const shown = suggestTargetPrice(100_000, { marginCoefficient: 1.4, priceRounding: 1000 }, true).basis;
    const hidden = suggestTargetPrice(100_000, { marginCoefficient: 1.4, priceRounding: 1000 }, false).basis;
    expect(shown).toContain('100.000');
    expect(hidden).not.toContain('100.000');
    expect(hidden).toContain('hệ số lãi 1,4');
  });
});

describe('suggestMinQty', () => {
  it('AC3: bán 30 trong 30 ngày (1/ngày) × 7 ngày chờ + 2 tồn an toàn = 9', () => {
    expect(suggestMinQty({ soldQty: 30, leadDays: 7, safetyQty: 2, defaultQty: 5 })?.value).toBe(9);
  });

  it('làm tròn lên phần lẻ của tốc độ bán: 10 trong 30 ngày × 7 ngày = 2,33 → 3, không tồn an toàn', () => {
    expect(suggestMinQty({ soldQty: 10, leadDays: 7, safetyQty: null, defaultQty: null })?.value).toBe(3);
  });

  it('chưa bán được cái nào thì lấy mặc định của danh mục', () => {
    expect(suggestMinQty({ soldQty: 0, leadDays: 7, safetyQty: 2, defaultQty: 5 })).toMatchObject({ value: 5 });
  });

  it('có lịch sử bán nhưng danh mục chưa đặt số ngày chờ thì lùi về mặc định; thiếu cả hai thì không gợi ý', () => {
    expect(suggestMinQty({ soldQty: 10, leadDays: null, safetyQty: 2, defaultQty: 4 })?.value).toBe(4);
    expect(suggestMinQty({ soldQty: 10, leadDays: null, safetyQty: 2, defaultQty: null })).toBeNull();
    expect(suggestMinQty({ soldQty: 0, leadDays: 7, safetyQty: 2, defaultQty: null })).toBeNull();
  });
});

describe('suggestFromSiblings', () => {
  const sibling = (sku: string, weightG: number | null) => ({
    sku,
    values: { standardPrice: null, targetNetPrice: null, weightG, lengthMm: null, widthMm: null, heightMm: null },
  });

  it('AC4: chép từ SKU anh em gần nhất (đầu danh sách) đã có số ở ô đó', () => {
    expect(suggestFromSiblings('weightG', [sibling('A-1', null), sibling('A-2', 250), sibling('A-3', 300)])).toEqual({
      value: 250,
      basis: 'chép từ SKU A-2 cùng sản phẩm',
    });
  });

  it('không anh em nào có số thì không gợi ý', () => {
    expect(suggestFromSiblings('weightG', [sibling('A-1', null)])).toBeNull();
    expect(suggestFromSiblings('weightG', [])).toBeNull();
  });
});
