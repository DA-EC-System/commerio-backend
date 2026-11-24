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

describe('groupVariants: ảnh theo giá trị (#295)', () => {
  const c = (value: string, valueId: string) => ({ attributeId: 'a-color', attributeName: 'Màu', value, valueId });
  const s = (value: string, valueId: string) => ({ attributeId: 'a-size', attributeName: 'Cỡ', value, valueId });
  const map = { 'a-color': '__custom', 'a-size': '__custom' };

  it('trục gắn ảnh tìm theo attributeValueId; mỗi giá trị lấy ảnh của SKU mang nó; trục kia không có ảnh', () => {
    const g = groupVariants(
      [
        { id: 'v1', attributes: [c('Đen', 'den'), s('S', 's')], image: { attributeValueId: 'den', url: 'u-den' } },
        { id: 'v2', attributes: [c('Đen', 'den'), s('M', 'm')], image: { attributeValueId: 'den', url: 'u-den' } },
        { id: 'v3', attributes: [c('Trắng', 'trang'), s('S', 's')], image: { attributeValueId: 'trang', url: 'u-trang' } },
      ],
      map,
      null,
    );
    if (!g.ok) throw new Error(g.message);
    expect(g.axes[0]!.values).toEqual([
      { optionId: null, label: 'Đen', imageUrl: 'u-den' },
      { optionId: null, label: 'Trắng', imageUrl: 'u-trang' },
    ]);
    expect(g.axes[1]!.values.every((v) => !('imageUrl' in v))).toBe(true);
  });

  it('một giá trị của trục thiếu ảnh, hoặc link rỗng: không gắn ảnh nào', () => {
    for (const second of [null, { attributeValueId: 'trang', url: '' }]) {
      const g = groupVariants(
        [
          { id: 'v1', attributes: [c('Đen', 'den')], image: { attributeValueId: 'den', url: 'u-den' } },
          { id: 'v2', attributes: [c('Trắng', 'trang')], image: second },
        ],
        map,
        null,
      );
      if (!g.ok) throw new Error(g.message);
      expect(g.axes[0]!.values.some((v) => 'imageUrl' in v)).toBe(false);
    }
  });
});

describe('groupVariants: thuộc tính biến thể ghép (#568)', () => {
  const free: PlatformAttribute[] = [{ ...leaf[0]!, allowCustom: true }];
  const cv = (value: string, valueId: string) => ({ attributeId: 'a-color', attributeName: 'Màu', value, valueId });
  const sv = (value: string, valueId: string) => ({ attributeId: 'a-size', attributeName: 'Cỡ', value, valueId });
  const both = { 'a-color': 'color_family', 'a-size': 'color_family' };

  it('hai trục cùng đích thành một thuộc tính biến thể, giá trị nối " - " theo thứ tự trục', () => {
    const g = groupVariants(
      [
        { id: 'v1', attributes: [cv('Đen', 'den'), sv('S', 's')] },
        { id: 'v2', attributes: [cv('Đen', 'den'), sv('M', 'm')] },
      ],
      both,
      free,
    );
    expect(g).toEqual({
      ok: true,
      axes: [{ code: 'color_family', name: 'Màu sắc', values: [{ optionId: null, label: 'Đen - S' }, { optionId: null, label: 'Đen - M' }] }],
      valuesOf: new Map([
        ['v1', ['Đen - S']],
        ['v2', ['Đen - M']],
      ]),
    });
  });

  it('mỗi trục __custom vẫn là một thuộc tính riêng', () => {
    const g = groupVariants([{ id: 'v1', attributes: [cv('Đen', 'den'), sv('S', 's')] }], { 'a-color': '__custom', 'a-size': '__custom' }, null);
    expect(g.ok && g.axes.map((a) => a.name)).toEqual(['Màu', 'Cỡ']);
  });

  it('trục ảnh nằm trong nhóm ghép: mỗi giá trị ghép lấy ảnh giá trị màu của nó', () => {
    const g = groupVariants(
      [
        { id: 'v1', attributes: [cv('Đen', 'den'), sv('S', 's')], image: { attributeValueId: 'den', url: 'u-den' } },
        { id: 'v2', attributes: [cv('Trắng', 'trang'), sv('S', 's')], image: { attributeValueId: 'trang', url: 'u-trang' } },
      ],
      both,
      free,
    );
    if (!g.ok) throw new Error(g.message);
    expect(g.axes[0]!.values).toEqual([
      { optionId: null, label: 'Đen - S', imageUrl: 'u-den' },
      { optionId: null, label: 'Trắng - S', imageUrl: 'u-trang' },
    ]);
  });
});
