import { describe, expect, it } from 'vitest';
import { lazadaCascade } from '#src/modules/channel/channel/service/marketplaces/lazada.ts';

// Đọc phản hồi GetNextCascadeProp (#400): `prop` cấp kế, `propValue` giá trị kèm `leaf` (open.lazada.com, tra 19/11/2026).
describe('lazadaCascade', () => {
  it('đổi prop, propValue sang dạng chung; id số thành chuỗi', () => {
    expect(
      lazadaCascade({ prop: { id: 100006867, name: 'Tỉnh', required: true }, propValue: [{ id: 160387, name: 'Hà Nội', leaf: false }] }),
    ).toEqual({ prop: { id: '100006867', label: 'Tỉnh', required: true }, items: [{ id: '160387', label: 'Hà Nội', leaf: false }] });
  });

  it('cấp cuối không có prop: prop null; dữ liệu vắng thì rỗng; giá trị không id bỏ', () => {
    expect(lazadaCascade({ propValue: [{ id: 1, name: 'A', leaf: true }, { name: 'B' }] })).toEqual({ prop: null, items: [{ id: '1', label: 'A', leaf: true }] });
    expect(lazadaCascade(undefined)).toEqual({ prop: null, items: [] });
  });
});
