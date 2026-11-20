import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import type { ListingVariant } from '#src/modules/channel/channel/service/product-port.ts';
import { keepsPlatformContent, pushBlock, pushSpec, type SpecCheck } from '#src/modules/channel/channel/service/push-block.ts';

// Mã chặn size_chart_missing (#347, Documents/21 §18.5).
const variant: ListingVariant = {
  id: 'v',
  productId: 'p',
  productName: 'Áo',
  sku: 'A-1',
  attributesLabel: '',
  productCode: 'SP-TEST',
  groupId: 'GROUP-TEST',
  attributes: [],
  archived: false,
  businessStatus: 'selling',
  description: null,
  weightG: 100,
  lengthMm: 100,
  widthMm: 100,
  heightMm: 100,
};
const map = (sizeChartRule: SpecCheck['sizeChartRule'], extra: Partial<SpecCheck> = {}): SpecCheck => ({
  externalCategoryId: 'L1',
  missing: [],
  permission: null,
  sizeChartRule,
  ...extra,
});
const price = new Decimal(1000);

describe('pushBlock: bảng kích cỡ', () => {
  it('danh mục bắt buộc mà sản phẩm chưa có ảnh bảng kích cỡ: size_chart_missing', () => {
    expect(pushBlock(variant, price, map('required'), true, false)).toMatchObject({ code: 'size_chart_missing' });
  });

  it('danh mục bắt buộc và sản phẩm có ảnh: qua', () => {
    expect(pushBlock(variant, price, map('required'), true, true)).toBeNull();
  });

  it.each(['optional', 'unsupported', null] as const)('quy tắc %s: không chặn dù thiếu ảnh bảng kích cỡ', (rule) => {
    expect(pushBlock(variant, price, map(rule), true, false)).toBeNull();
  });

  it('không truyền hasSizeChart (gọi kiểu cũ) thì danh mục bắt buộc vẫn chặn', () => {
    expect(pushBlock(variant, price, map('required'), true)).toMatchObject({ code: 'size_chart_missing' });
  });

  it('thứ tự kiểm: thiếu ảnh sản phẩm báo images_missing trước, thiếu giá báo price_missing trước', () => {
    expect(pushBlock(variant, price, map('required'), false, false)?.code).toBe('images_missing');
    expect(pushBlock(variant, null, map('required'), true, false)?.code).toBe('price_missing');
  });
});

// Mã chặn theo spec sàn (#400 A14, Documents/21 §18.5): chưa có spec, còn thiếu, gian hàng chưa được bán category.
describe('pushBlock: spec sàn', () => {
  it('chưa có spec: category_unmapped, sau price_missing, trước dimensions_missing', () => {
    expect(pushBlock(variant, price, undefined, true)?.code).toBe('category_unmapped');
    expect(pushBlock(variant, null, undefined, true)?.code).toBe('price_missing');
    expect(pushBlock({ ...variant, weightG: null }, price, undefined, true)?.code).toBe('category_unmapped');
  });

  it('spec còn thiếu: spec_incomplete, message liệt kê nhãn', () => {
    const missing = [
      { code: 'a', label: 'Chất liệu', reason: 'required' as const },
      { code: 'b', label: 'Màu', reason: 'axis_unmapped' as const },
    ];
    const block = pushBlock(variant, price, map(null, { missing }), true);
    expect(block).toEqual({ code: 'spec_incomplete', message: 'Chất liệu, Màu' });
  });

  it('quyền category khác available: category_not_permitted; available hoặc chưa biết: qua', () => {
    expect(pushBlock(variant, price, map(null, { permission: 'invite_only' as SpecCheck['permission'] }), true)?.code).toBe('category_not_permitted');
    expect(pushBlock(variant, price, map(null, { permission: 'available' }), true)).toBeNull();
    expect(pushBlock(variant, price, map(null), true)).toBeNull();
  });
});

// Đẩy lại SKU người bán (review BE2 P1-1, Thành chốt 19/11/2026): một vị từ cho request và việc nền.
describe('keepsPlatformContent, pushSpec', () => {
  const row = { contentSource: 'platform' as const, externalProductId: 'P', externalSkuId: 'S' };
  it('platform có mã sàn, không take-over → giữ nội dung người bán; app, thiếu mã sàn, take-over hay chưa có listing → không', () => {
    expect(keepsPlatformContent(row)).toBe(true);
    expect(keepsPlatformContent(row, true)).toBe(false);
    expect(keepsPlatformContent({ ...row, contentSource: 'app' })).toBe(false);
    expect(keepsPlatformContent({ ...row, externalSkuId: null })).toBe(false);
    expect(keepsPlatformContent(undefined)).toBe(false);
  });

  it('giữ nội dung: spec trung tính (chưa có spec, còn thiếu, không có quyền đều không chặn); không giữ: spec như có', () => {
    const bad: SpecCheck = { externalCategoryId: 'L', missing: [{ code: 'a', label: 'A', reason: 'required' }], permission: 'invite_only', sizeChartRule: 'required' };
    expect(pushBlock(variant, new Decimal(1), pushSpec(true, undefined), true)).toBeNull();
    expect(pushBlock(variant, new Decimal(1), pushSpec(true, bad), true)).toBeNull();
    expect(pushBlock(variant, new Decimal(1), pushSpec(false, undefined), true)?.code).toBe('category_unmapped');
    expect(pushBlock(variant, new Decimal(1), pushSpec(false, bad), true)?.code).toBe('spec_incomplete');
  });
});
