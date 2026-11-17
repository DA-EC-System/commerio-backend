import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import type { CategoryMapRow } from '#src/modules/channel/channel/repository/category-maps.ts';
import type { ListingVariant } from '#src/modules/channel/channel/service/product-port.ts';
import { pushBlock } from '#src/modules/channel/channel/service/push-block.ts';

// Mã chặn size_chart_missing (#347, Documents/21 §18.5).
const variant: ListingVariant = {
  id: 'v',
  productId: 'p',
  productName: 'Áo',
  sku: 'A-1',
  categoryId: 'c',
  attributesLabel: '',
  archived: false,
  businessStatus: 'selling',
  description: null,
  weightG: 100,
  lengthMm: 100,
  widthMm: 100,
  heightMm: 100,
};
const map = (sizeChartRule: CategoryMapRow['sizeChartRule']) => ({ sizeChartRule }) as CategoryMapRow;
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
