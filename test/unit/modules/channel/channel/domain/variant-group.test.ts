import { describe, expect, it } from 'vitest';
import type { PlatformAttribute } from '#src/modules/channel/channel/domain/product-spec.ts';
import { groupVariants } from '#src/modules/channel/channel/domain/variant-group.ts';

// Gom SKU của một cha thành một sản phẩm sàn nhiều phân loại (#295, Documents/21 §18.8.3–18.8.4).
const color = (value: string) => ({ attributeId: 'a-color', attributeName: 'Màu', value });
const size = (value: string) => ({ attributeId: 'a-size', attributeName: 'Cỡ', value });
const leaf: PlatformAttribute[] = [
  {
    code: 'color_family',
    label: 'Màu sắc',
    kind: 'sales',
    input: 'select',
    options: [
      { id: '1', label: 'Đen' },
      { id: '2', label: 'Trắng' },
    ],
    allowCustom: false,
    required: true,
    requiredWhen: null,
    isKey: false,
    tier: 'category',
    raw: {},
  },
];

describe('groupVariants', () => {
  it('trục theo axisMap, giá trị khớp lựa chọn của leaf theo nhãn, trục tự đặt giữ nhãn catalog', () => {
    const g = groupVariants(
      [
        { id: 'v1', attributes: [color('đen '), size('S')] },
        { id: 'v2', attributes: [color('Trắng'), size('S')] },
      ],
      { 'a-color': 'color_family', 'a-size': '__custom' },
      leaf,
    );
    expect(g).toEqual({
      ok: true,
      axes: [
        { code: 'color_family', name: 'Màu sắc', values: [{ optionId: '1', label: 'Đen' }, { optionId: '2', label: 'Trắng' }] },
        { code: null, name: 'Cỡ', values: [{ optionId: null, label: 'S' }] },
      ],
      valuesOf: new Map([
        ['v1', ['Đen', 'S']],
        ['v2', ['Trắng', 'S']],
      ]),
    });
  });

  it('một SKU không thuộc tính: không trục', () => {
    expect(groupVariants([{ id: 'v1', attributes: [] }], {}, leaf)).toEqual({ ok: true, axes: [], valuesOf: new Map([['v1', []]]) });
  });

  it('nhiều SKU không trục, khác bộ trục: axis_shape', () => {
    expect(groupVariants([{ id: 'v1', attributes: [] }, { id: 'v2', attributes: [] }], {}, leaf)).toMatchObject({ ok: false, code: 'axis_shape' });
    expect(
      groupVariants([{ id: 'v1', attributes: [color('Đen')] }, { id: 'v2', attributes: [size('S')] }], { 'a-color': 'color_family', 'a-size': '__custom' }, leaf),
    ).toMatchObject({ ok: false, code: 'axis_shape' });
  });

  it('trục chưa ánh xạ: axis_unmapped', () => {
    expect(groupVariants([{ id: 'v1', attributes: [color('Đen')] }], {}, leaf)).toMatchObject({ ok: false, code: 'axis_unmapped' });
  });
});
