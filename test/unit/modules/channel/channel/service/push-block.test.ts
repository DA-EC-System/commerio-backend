import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import type { ListingVariant } from '#src/modules/channel/channel/service/product-port.ts';
import {
  keepsPlatformContent,
  pushBlock,
  pushSpec,
  type SpecCheck,
  variantImageGap,
  variantImageGaps,
} from '#src/modules/channel/channel/service/push-block.ts';

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

describe('ảnh theo giá trị có một phần (#295, 21 §18.5 variant_images_missing)', () => {
  const sku = (id: string, color: [string, string], size: [string, string], image: string | null, archived = false): ListingVariant => ({
    ...variant,
    id,
    archived,
    attributes: [
      { attributeId: 'a-color', attributeName: 'Màu sắc', platformKind: 'color', valueId: color[0], value: color[1] },
      { attributeId: 'a-size', attributeName: 'Kích cỡ', platformKind: 'size', valueId: size[0], value: size[1] },
    ],
    image: image ? { attributeValueId: image, url: `https://cdn.test/${image}.png` } : null,
  });

  it('một màu có ảnh, màu khác (SKU chưa lưu trữ) chưa có: liệt kê giá trị thiếu, không lặp; SKU đã lưu trữ không tính', () => {
    const vs = [
      sku('1', ['den', 'Đen'], ['s', 'S'], 'den'),
      sku('2', ['trang', 'Trắng'], ['s', 'S'], null),
      sku('3', ['trang', 'Trắng'], ['m', 'M'], null),
      sku('4', ['xanh', 'Xanh'], ['s', 'S'], null, true),
    ];
    expect(variantImageGap(vs)).toEqual({ attributeName: 'Màu sắc', values: ['Trắng'] });
  });

  it('chưa có ảnh phân loại nào, hoặc đủ ảnh: không chặn', () => {
    expect(variantImageGap([sku('1', ['den', 'Đen'], ['s', 'S'], null), sku('2', ['trang', 'Trắng'], ['s', 'S'], null)])).toBeNull();
    expect(variantImageGap([sku('1', ['den', 'Đen'], ['s', 'S'], 'den'), sku('2', ['trang', 'Trắng'], ['m', 'M'], 'trang')])).toBeNull();
  });

  it('chỉ chặn khi adapter khai requiresAllVariantImages; pushBlock trả mã và câu "thêm ảnh … rồi đăng lại"', () => {
    const vs = [sku('1', ['den', 'Đen'], ['s', 'S'], 'den'), sku('2', ['trang', 'Trắng'], ['s', 'S'], null)];
    expect(variantImageGaps({}, vs).size).toBe(0);
    const gap = variantImageGaps({ requiresAllVariantImages: true }, vs).get('p')!;
    expect(pushBlock(variant, price, map('optional'), true, false, gap)).toEqual({
      code: 'variant_images_missing',
      message: 'Sàn bắt buộc ảnh cho mọi giá trị của Màu sắc: thêm ảnh cho Trắng rồi đăng lại',
    });
    // Thiếu ảnh sản phẩm báo trước.
    expect(pushBlock(variant, price, map('optional'), false, false, gap)).toMatchObject({ code: 'images_missing' });
  });
});
