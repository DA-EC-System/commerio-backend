// Ghép trục phân loại với sales attribute của sàn (#448 L2): nguồn công ty → mặc định theo platform_kind → __custom,
// mỗi mã một trục, valueMap theo nhãn; `specMissing` thêm sales_required, axis_limit, __custom theo caps.
import { describe, expect, it } from 'vitest';
import { suggestAxes, type AxisInput } from '#src/modules/channel/channel/domain/axis-match.ts';
import { CUSTOM_AXIS, type PlatformAttribute, specMissing, type VariantCapabilities } from '#src/modules/channel/channel/domain/product-spec.ts';

const sales = (code: string, label = code, options: { id: string; label: string }[] = [], raw: Record<string, unknown> = {}): PlatformAttribute => ({
  code,
  label,
  kind: 'sales',
  input: 'select',
  options,
  allowCustom: true,
  required: false,
  requiredWhen: null,
  isKey: false,
  tier: 'category',
  raw,
});
const color: AxisInput = {
  attributeId: 'a-color',
  name: 'Màu',
  platformKind: 'color',
  values: [
    { valueId: 'v-red', value: 'Đỏ' },
    { valueId: 'v-blue', value: 'Xanh dương' },
  ],
};
const size: AxisInput = { attributeId: 'a-size', name: 'Kích cỡ', platformKind: 'size', values: [{ valueId: 'v-m', value: 'M' }] };
const custom: AxisInput = { attributeId: 'a-mat', name: 'Chất liệu', platformKind: null, values: [] };
const tiktokStd = { color: ['100000'], size: ['100007', '100001'] };
const tiktokCaps: VariantCapabilities = { maxAxes: 3, customAxisName: true, salesRequired: [], addVariant: true, maxValueLength: null, maxAxisValues: null, maxAxisNameLength: null };
// Sàn không nhận tên tự đặt (nhánh chung; Lazada thật nhận từ #572).
const noCustomCaps: VariantCapabilities = { maxAxes: 2, customAxisName: false, salesRequired: [], addVariant: true, maxValueLength: null, maxAxisValues: null, maxAxisNameLength: null };

describe('suggestAxes', () => {
  it('TikTok leaf có 100000 và 100007: Màu, Kích cỡ ra hai mã chuẩn', () => {
    const leaf = [sales('100000'), sales('100007')];
    const r = suggestAxes({ axes: [color, size], leaf, companyCodes: new Map(), standard: tiktokStd, caps: tiktokCaps });
    expect(r.axisMap).toEqual({ 'a-color': '100000', 'a-size': '100007' });
  });

  it('leaf chỉ có 100000: trục size thành __custom khi sàn nhận tên tự đặt', () => {
    const r = suggestAxes({ axes: [color, size], leaf: [sales('100000')], companyCodes: new Map(), standard: tiktokStd, caps: tiktokCaps });
    expect(r.axisMap).toEqual({ 'a-color': '100000', 'a-size': CUSTOM_AXIS });
  });

  it('Lazada không nhận tên tự đặt: leaf không có size thì bỏ trống', () => {
    const r = suggestAxes({
      axes: [color, size],
      leaf: [sales('color_family')],
      companyCodes: new Map(),
      standard: { color: ['color_family'], size: ['size'] },
      caps: noCustomCaps,
    });
    expect(r.axisMap).toEqual({ 'a-color': 'color_family' });
  });

  it('mã công ty cấu hình thắng mặc định; mã đã dùng không dùng lại; thử mã kế khi leaf không có', () => {
    const leaf = [sales('100001'), sales('100007')];
    const companyCodes = new Map([['a-size', ['9999', '100001']]]);
    const r = suggestAxes({ axes: [size, { ...color, attributeId: 'a-size2', platformKind: 'size' }], leaf, companyCodes, standard: tiktokStd, caps: tiktokCaps });
    expect(r.axisMap).toEqual({ 'a-size': '100001', 'a-size2': '100007' });
  });

  it('nhiều trục hơn maxAxes mà leaf có đích ghép: gợi ý ghép mọi trục, không valueMap (#568)', () => {
    const leaf = [sales('color_family', 'Màu sắc', [{ id: '10', label: 'Đỏ' }])];
    const r = suggestAxes({ axes: [color, size], leaf, companyCodes: new Map(), standard: { color: ['color_family'] }, caps: { ...noCustomCaps, maxAxes: 1 } });
    expect(r).toEqual({ axisMap: { 'a-color': 'color_family', 'a-size': 'color_family' }, valueMap: {} });
  });

  it('nhiều trục hơn maxAxes mà leaf không có đích ghép (kiểu số): giữ gợi ý thường', () => {
    const leaf = [{ ...sales('weight'), input: 'number' as const }];
    const r = suggestAxes({ axes: [color, size], leaf, companyCodes: new Map(), standard: { color: ['weight'] }, caps: { ...noCustomCaps, maxAxes: 1 } });
    expect(r.axisMap).toEqual({ 'a-color': 'weight' });
  });

  it('leaf null trả rỗng', () => {
    expect(suggestAxes({ axes: [color], leaf: null, companyCodes: new Map(), standard: tiktokStd, caps: tiktokCaps })).toEqual({ axisMap: {}, valueMap: {} });
  });

  it('thuộc tính tự đặt không có mặc định: __custom nếu được, không thì bỏ trống', () => {
    const base = { axes: [custom], leaf: [sales('100000')], companyCodes: new Map(), standard: tiktokStd };
    expect(suggestAxes({ ...base, caps: tiktokCaps }).axisMap).toEqual({ 'a-mat': CUSTOM_AXIS });
    expect(suggestAxes({ ...base, caps: noCustomCaps }).axisMap).toEqual({});
  });

  it('valueMap ghép theo nhãn bỏ dấu và theo en_name; không khớp thì bỏ', () => {
    const leaf = [
      sales('color_family', 'Màu', [{ id: '10', label: 'Đỏ' }, { id: '11', label: 'Xanh' }], {
        options: [{ id: 10, en_name: 'Red' }, { id: 11, en_name: 'Blue' }],
      }),
    ];
    const r = suggestAxes({
      axes: [{ ...color, values: [{ valueId: 'v1', value: 'do' }, { valueId: 'v2', value: 'blue' }, { valueId: 'v3', value: 'Tím' }] }],
      leaf,
      companyCodes: new Map(),
      standard: { color: ['color_family'] },
      caps: noCustomCaps,
    });
    expect(r.valueMap).toEqual({ v1: '10', v2: '11' });
  });
});

describe('specMissing với caps', () => {
  const base = { attributes: {}, categoryStatus: 'ok' as const };
  const axes = [{ attributeId: 'a1', name: 'Màu' }];

  it('__custom không hợp lệ khi sàn không nhận tên trục tự đặt, hợp lệ khi caps null hoặc nhận', () => {
    const spec = { ...base, axisMap: { a1: CUSTOM_AXIS } };
    expect(specMissing({ spec, attributes: [], axes, caps: noCustomCaps })).toEqual([{ code: 'a1', label: 'Màu', reason: 'axis_unmapped' }]);
    expect(specMissing({ spec, attributes: [], axes, caps: tiktokCaps })).toEqual([]);
    expect(specMissing({ spec, attributes: [], axes })).toEqual([]);
  });

  it('sales_required: mã bắt buộc chưa có trong axisMap', () => {
    const caps = { ...noCustomCaps, salesRequired: ['color_family'] };
    const attributes = [sales('color_family', 'Màu sắc')];
    expect(specMissing({ spec: { ...base, axisMap: {} }, attributes, axes: [], caps })).toEqual([
      { code: 'color_family', label: 'Màu sắc', reason: 'sales_required' },
    ]);
    expect(specMissing({ spec: { ...base, axisMap: { a1: 'color_family' } }, attributes, axes, caps })).toEqual([]);
  });

  it('axis_limit: nhiều thuộc tính biến thể hơn category nhận; mỗi trục __custom tính riêng', () => {
    const two = [...axes, { attributeId: 'a2', name: 'Cỡ' }];
    const spec = { ...base, axisMap: { a1: CUSTOM_AXIS, a2: CUSTOM_AXIS } };
    expect(specMissing({ spec, attributes: [], axes: two, caps: { ...tiktokCaps, maxAxes: 1 } })).toEqual([
      { code: 'axes', label: 'Sản phẩm có 2 thuộc tính biến thể, category này nhận tối đa 1', reason: 'axis_limit' },
    ]);
  });

  it('axis_name_too_long: tên tự đặt dài hơn maxAxisNameLength, đếm theo ký tự (code point), chỉ xét __custom (#572)', () => {
    const caps = { ...tiktokCaps, maxAxisNameLength: 5 };
    const named = [{ attributeId: 'a1', name: 'Phần loại' }, { attributeId: 'a2', name: 'Màu sắc riêng' }];
    const spec = { ...base, axisMap: { a1: CUSTOM_AXIS, a2: 'color_family' } };
    expect(specMissing({ spec, attributes: [sales('color_family')], axes: named, caps, platformName: 'TikTok' })).toEqual([
      { code: 'a1', label: 'Tên thuộc tính biến thể “Phần loại” dài 9 ký tự, TikTok nhận tối đa 5', reason: 'axis_name_too_long' },
    ]);
    // Đúng biên: 5 ký tự có dấu ("Phầnx", 7 byte UTF-8) vẫn qua; không giới hạn (null) thì không báo
    expect(specMissing({ spec, attributes: [sales('color_family')], axes: [{ attributeId: 'a1', name: 'Phầnx' }], caps })).toEqual([]);
    expect(specMissing({ spec, attributes: [sales('color_family')], axes: named, caps: tiktokCaps })).toEqual([]);
  });

  describe('thuộc tính biến thể ghép (#568)', () => {
    const two = [...axes, { attributeId: 'a2', name: 'Cỡ' }];
    const leaf = [sales('color_family', 'Màu sắc')];
    const caps: VariantCapabilities = { ...noCustomCaps, maxAxes: 1, maxValueLength: 20, maxAxisValues: 50 };
    const combinedSpec = { ...base, axisMap: { a1: 'color_family', a2: 'color_family' } };
    const variants = [
      { a1: 'Đỏ', a2: 'S' },
      { a1: 'Đỏ', a2: 'M' },
    ];

    it('hai trục ghép một đích, maxAxes 1: tính là một thuộc tính biến thể, không axis_limit', () => {
      expect(specMissing({ spec: combinedSpec, attributes: leaf, axes: two, caps, variants, platformName: 'Lazada' })).toEqual([]);
    });

    it('đích không nhận chữ ghép (chỉ lựa chọn có sẵn, kiểu số) thì axis_unmapped từng trục', () => {
      for (const bad of [{ ...leaf[0]!, allowCustom: false }, { ...leaf[0]!, input: 'number' as const }]) {
        expect(specMissing({ spec: combinedSpec, attributes: [bad], axes: two, caps, variants }).map((m) => [m.code, m.reason])).toEqual([
          ['a1', 'axis_unmapped'],
          ['a2', 'axis_unmapped'],
        ]);
      }
    });

    it('axis_value_too_long: giá trị ghép dài hơn maxValueLength, chặn chứ không rút gọn', () => {
      const long = [{ a1: 'Xanh dương đậm', a2: 'XXL rộng' }];
      expect(specMissing({ spec: combinedSpec, attributes: leaf, axes: two, caps, variants: long, platformName: 'Lazada' })).toEqual([
        { code: 'color_family', label: 'Giá trị “Xanh dương đậm - XXL rộng” dài 25 ký tự, Lazada nhận tối đa 20', reason: 'axis_value_too_long' },
      ]);
    });

    it('axis_too_many_values: số giá trị ghép vượt maxAxisValues', () => {
      const many = Array.from({ length: 3 }, (_, i) => ({ a1: 'Đỏ', a2: String(i) }));
      expect(specMissing({ spec: combinedSpec, attributes: leaf, axes: two, caps: { ...caps, maxAxisValues: 2 }, variants: many })).toEqual([
        { code: 'color_family', label: 'Thuộc tính biến thể ghép có 3 giá trị, sàn nhận tối đa 2', reason: 'axis_too_many_values' },
      ]);
    });

    it('giới hạn chỉ kiểm trên trục ghép: trục đơn dài vẫn qua', () => {
      const spec = { ...base, axisMap: { a1: 'color_family' } };
      const one = [{ a1: 'Một giá trị rất dài hơn hai mươi ký tự' }];
      expect(specMissing({ spec, attributes: leaf, axes, caps, variants: one })).toEqual([]);
    });
  });
});
