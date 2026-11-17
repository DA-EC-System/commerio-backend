import { describe, expect, it } from 'vitest';
import { clearedSkuFields } from '#src/modules/product/catalog/service/listed-fields.ts';

// Trường bị xoá trống của một lần sửa SKU (#204, US-SP-03 dòng 7).
const FULL = { targetNetPrice: '150000.00', weightG: 200, lengthMm: 100, widthMm: 100, heightMm: 50 };
const EMPTY = { targetNetPrice: null, weightG: null, lengthMm: null, widthMm: null, heightMm: null };

describe('clearedSkuFields', () => {
  it('null cho ô đang có giá trị là xoá trống, theo thứ tự giá, cân nặng, ba cạnh', () => {
    expect(clearedSkuFields(FULL, { heightMm: null, targetNetPrice: null, weightG: null })).toEqual(['targetNetPrice', 'weightG', 'heightMm']);
  });

  it('null cho ô đã trống, bỏ trường, hay đổi sang số khác thì không tính', () => {
    expect(clearedSkuFields(EMPTY, { weightG: null, targetNetPrice: null })).toEqual([]);
    expect(clearedSkuFields(FULL, { weightG: 300, lengthMm: undefined })).toEqual([]);
  });

  it('giá chuẩn không phải trường bắt buộc chung: không có trong danh sách xét', () => {
    expect(clearedSkuFields(FULL, { standardPrice: null } as never)).toEqual([]);
  });
});
