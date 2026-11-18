import { describe, expect, it } from 'vitest';
import { countLabels, mainLabel, readinessOf } from '#src/modules/product/catalog/domain/labels.ts';

// Độ hoàn thiện, nhãn chính, đếm nhãn của SKU (#204, Documents/21 §17.1, 25 §5.1, §5.2; D7, D8 Thành sửa 16/11/2026).
const parent = { name: 'Áo thun', categoryId: 'c1', imageCount: 1, variantImagesPartial: false };
const full = { targetNetPrice: '150000.00', minQty: 5, weightG: 250, lengthMm: 200, widthMm: 100, heightMm: 30 };

describe('readinessOf', () => {
  it('đủ mọi trường → ready, missing rỗng', () => {
    expect(readinessOf(parent, full)).toEqual({ readiness: 'ready', missing: [] });
  });

  it('mỗi trường thiếu ra đúng phần tử, theo thứ tự cố định', () => {
    const r = readinessOf(
      { name: ' ', categoryId: null, imageCount: 0, variantImagesPartial: true },
      { targetNetPrice: null, minQty: null, weightG: null, lengthMm: 200, widthMm: null, heightMm: 30 },
    );
    expect(r).toEqual({
      readiness: 'incomplete',
      missing: ['name', 'category', 'image', 'variantImages', 'price', 'minQty', 'weight', 'dimensions'],
    });
  });

  it('chỉ một kích thước trống → dimensions; giá muốn bán là target_net_price (D7)', () => {
    expect(readinessOf(parent, { ...full, heightMm: null }).missing).toEqual(['dimensions']);
    expect(readinessOf(parent, { ...full, targetNetPrice: null }).missing).toEqual(['price']);
  });

  it('cha không ảnh → SKU nào cũng thiếu image', () => {
    expect(readinessOf({ ...parent, imageCount: 0 }, full).missing).toEqual(['image']);
  });

  it('ảnh phân loại có một phần → variantImages ngay sau image, SKU incomplete; đủ hoặc chưa có ảnh nào thì không (#340)', () => {
    expect(readinessOf({ ...parent, variantImagesPartial: true }, full)).toEqual({ readiness: 'incomplete', missing: ['variantImages'] });
    expect(readinessOf({ ...parent, imageCount: 0, variantImagesPartial: true }, { ...full, targetNetPrice: null }).missing).toEqual([
      'image',
      'variantImages',
      'price',
    ]);
    expect(readinessOf({ ...parent, variantImagesPartial: false }, full).readiness).toBe('ready');
  });
});

describe('mainLabel (D8)', () => {
  it.each([
    ['paused', 'live', 'paused'],
    ['discontinued', 'error', 'discontinued'],
    ['archived', 'live', 'archived'],
    ['selling', 'live', 'live'],
    ['selling', 'error', 'error'],
    ['selling', 'pending', 'pending'],
    ['selling', 'not_listed', 'not_listed'],
  ] as const)('%s + %s → %s', (status, presence, label) => {
    expect(mainLabel(status, presence)).toBe(label);
  });
});

describe('countLabels', () => {
  it('đếm 7 nhãn trên mọi SKU; variantCount, incompleteCount, errorCount bỏ SKU lưu trữ; lỗi đếm cả SKU đang live', () => {
    const sku = (businessStatus: string, presence: string, hasListingError = false, readiness = 'ready') =>
      ({ businessStatus, presence, hasListingError, readiness }) as Parameters<typeof countLabels>[0][number];
    const result = countLabels([
      sku('selling', 'live'),
      sku('selling', 'live'),
      sku('selling', 'live', false, 'incomplete'),
      sku('selling', 'live', true),
      sku('archived', 'error', true, 'incomplete'),
      sku('selling', 'error', true),
    ]);
    expect(result).toEqual({
      variantCount: 5,
      variantTotal: 6,
      labelCounts: { archived: 1, discontinued: 0, paused: 0, live: 4, error: 1, pending: 0, not_listed: 0 },
      incompleteCount: 1,
      errorCount: 2,
    });
  });
});
