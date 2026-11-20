import { describe, expect, it } from 'vitest';
import { productSuggestConfig, suggestFromSiblings, suggestMinQty, suggestTargetPrice } from '#src/modules/product/catalog/domain/suggestion.ts';

// Gợi ý khi sửa hàng loạt (#242, 27 US-SP-04 AC 2, 3, 4).
const org = 'theo công ty';
const co = (value: number, source = org) => ({ value, source });
const NONE = { marginCoefficient: null, priceRounding: null, reorderLeadDays: null, reorderSafetyQty: null, reorderDefaultQty: null };

describe('suggestTargetPrice', () => {
  it('AC2: giá nhập 100.000, hệ số 1,4 → 140.000', () => {
    expect(suggestTargetPrice(100_000, { marginCoefficient: 1.4, priceRounding: null, source: org }, true).value).toBe(140_000);
  });

  it('làm tròn LÊN theo bước làm tròn: 205.000 × 1,6 = 328.000; 123.456 × 1,3 = 160.492,8 → 161.000', () => {
    expect(suggestTargetPrice('205000.00', { marginCoefficient: 1.6, priceRounding: 1000, source: org }, true).value).toBe(328_000);
    expect(suggestTargetPrice(123_456, { marginCoefficient: 1.3, priceRounding: 1000, source: org }, true).value).toBe(161_000);
  });

  it('không dính lỗi số thực: 0,1 + 0,2 kiểu số học nhị phân không đẩy giá lên một bước', () => {
    expect(suggestTargetPrice(10_000, { marginCoefficient: 1.1, priceRounding: 100, source: org }, true).value).toBe(11_000);
  });

  it('câu giải thích nêu giá nhập khi được xem, không nêu khi thiếu quyền xem giá vốn', () => {
    const shown = suggestTargetPrice(100_000, { marginCoefficient: 1.4, priceRounding: 1000, source: org }, true).basis;
    const hidden = suggestTargetPrice(100_000, { marginCoefficient: 1.4, priceRounding: 1000, source: org }, false).basis;
    expect(shown).toContain('100.000');
    expect(hidden).not.toContain('100.000');
    expect(hidden).toContain('hệ số lãi 1,4');
  });

  it('câu giải thích kết thúc bằng nguồn hệ số: theo nhóm hoặc theo công ty', () => {
    const byGroup = suggestTargetPrice(100_000, { marginCoefficient: 1.2, priceRounding: null, source: 'theo nhóm Điện tử' }, true).basis;
    expect(byGroup).toBe('100.000 đ giá nhập × hệ số lãi 1,2 theo nhóm Điện tử');
    expect(suggestTargetPrice(100_000, { marginCoefficient: 2, priceRounding: null, source: org }, true).basis).toMatch(/theo công ty$/);
  });
});

describe('suggestMinQty', () => {
  it('AC3: bán 30 trong 30 ngày (1/ngày) × 7 ngày chờ + 2 tồn an toàn = 9', () => {
    expect(suggestMinQty({ soldQty: 30, leadDays: co(7), safetyQty: co(2), defaultQty: co(5) })?.value).toBe(9);
  });

  it('làm tròn lên phần lẻ của tốc độ bán: 10 trong 30 ngày × 7 ngày = 2,33 → 3, không tồn an toàn', () => {
    expect(suggestMinQty({ soldQty: 10, leadDays: co(7), safetyQty: null, defaultQty: null })?.value).toBe(3);
  });

  it('chưa bán được cái nào thì lấy mặc định', () => {
    expect(suggestMinQty({ soldQty: 0, leadDays: co(7), safetyQty: co(2), defaultQty: co(5) })).toMatchObject({ value: 5 });
  });

  it('có lịch sử bán nhưng chưa đặt số ngày chờ thì lùi về mặc định; thiếu cả hai thì không gợi ý', () => {
    expect(suggestMinQty({ soldQty: 10, leadDays: null, safetyQty: co(2), defaultQty: co(4) })?.value).toBe(4);
    expect(suggestMinQty({ soldQty: 10, leadDays: null, safetyQty: co(2), defaultQty: null })).toBeNull();
    expect(suggestMinQty({ soldQty: 0, leadDays: co(7), safetyQty: co(2), defaultQty: null })).toBeNull();
  });
});

describe('suggestMinQty: nguồn trong câu giải thích', () => {
  it('có lịch sử bán: nêu nguồn của số ngày chờ; chưa bán: nêu nguồn của ngưỡng mặc định', () => {
    const sold = suggestMinQty({ soldQty: 30, leadDays: co(7, 'theo nhóm Điện tử'), safetyQty: co(2), defaultQty: null });
    expect(sold?.basis).toMatch(/theo nhóm Điện tử$/);
    const fresh = suggestMinQty({ soldQty: 0, leadDays: null, safetyQty: null, defaultQty: co(5) });
    expect(fresh?.basis).toBe('chưa có lịch sử bán, lấy ngưỡng mặc định theo công ty');
    const noLead = suggestMinQty({ soldQty: 10, leadDays: null, safetyQty: null, defaultQty: co(4, 'theo nhóm Giày dép') });
    expect(noLead?.basis).toBe('ngưỡng mặc định theo nhóm Giày dép (chưa đặt số ngày chờ hàng)');
  });
});

describe('productSuggestConfig', () => {
  it('nhóm có số thì lấy của nhóm, kèm nguồn "theo nhóm <tên>"', () => {
    const config = productSuggestConfig({ ...NONE, name: 'Điện tử', marginCoefficient: 1.2, priceRounding: 1000 }, { ...NONE, marginCoefficient: 2 });
    expect(config.marginCoefficient).toEqual({ value: 1.2, source: 'theo nhóm Điện tử' });
    expect(config.priceRounding).toEqual({ value: 1000, source: 'theo nhóm Điện tử' });
  });

  it('nhóm để trống (null) mà công ty có thì lấy của công ty, nguồn "theo công ty"; từng số tính riêng', () => {
    const config = productSuggestConfig(
      { ...NONE, name: 'Giày dép', reorderLeadDays: 3 },
      { ...NONE, marginCoefficient: 2, reorderLeadDays: 9, reorderDefaultQty: 5 },
    );
    expect(config.marginCoefficient).toEqual({ value: 2, source: 'theo công ty' });
    expect(config.reorderLeadDays).toEqual({ value: 3, source: 'theo nhóm Giày dép' });
    expect(config.reorderDefaultQty).toEqual({ value: 5, source: 'theo công ty' });
  });

  it('cả nhóm lẫn công ty trống thì null; số 0 của nhóm vẫn là số, không rơi xuống công ty', () => {
    const config = productSuggestConfig({ ...NONE, name: 'Khác', reorderSafetyQty: 0 }, { ...NONE, reorderSafetyQty: 4 });
    expect(config.marginCoefficient).toBeNull();
    expect(config.reorderSafetyQty).toEqual({ value: 0, source: 'theo nhóm Khác' });
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
