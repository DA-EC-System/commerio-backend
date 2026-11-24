// Ghép trục phân loại với sales attribute của sàn (#448 L2): nguồn công ty → mặc định theo platform_kind → __custom,
// mỗi mã một trục, valueMap theo nhãn; `specMissing` thêm sales_required, axis_shape, __custom theo caps.
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
const tiktokCaps: VariantCapabilities = { maxAxes: 3, customAxisName: true, salesRequired: [], addVariant: true, maxValueLength: null, maxAxisValues: null };
const lazadaCaps: VariantCapabilities = { maxAxes: 2, customAxisName: false, salesRequired: [], addVariant: true, maxValueLength: null, maxAxisValues: null };

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
      caps: lazadaCaps,
    });
    expect(r.axisMap).toEqual({ 'a-color': 'color_family' });
  });

  it('mã công ty cấu hình thắng mặc định; mã đã dùng không dùng lại; thử mã kế khi leaf không có', () => {
    const leaf = [sales('100001'), sales('100007')];
    const companyCodes = new Map([['a-size', ['9999', '100001']]]);
    const r = suggestAxes({ axes: [size, { ...color, attributeId: 'a-size2', platformKind: 'size' }], leaf, companyCodes, standard: tiktokStd, caps: tiktokCaps });
    expect(r.axisMap).toEqual({ 'a-size': '100001', 'a-size2': '100007' });
  });

  it('leaf null trả rỗng', () => {
    expect(suggestAxes({ axes: [color], leaf: null, companyCodes: new Map(), standard: tiktokStd, caps: tiktokCaps })).toEqual({ axisMap: {}, valueMap: {} });
  });

  it('thuộc tính tự đặt không có mặc định: __custom nếu được, không thì bỏ trống', () => {
    const base = { axes: [custom], leaf: [sales('100000')], companyCodes: new Map(), standard: tiktokStd };
    expect(suggestAxes({ ...base, caps: tiktokCaps }).axisMap).toEqual({ 'a-mat': CUSTOM_AXIS });
    expect(suggestAxes({ ...base, caps: lazadaCaps }).axisMap).toEqual({});
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
      caps: lazadaCaps,
    });
    expect(r.valueMap).toEqual({ v1: '10', v2: '11' });
  });
});

describe('specMissing với caps', () => {
  const base = { attributes: {}, categoryStatus: 'ok' as const };
  const axes = [{ attributeId: 'a1', name: 'Màu' }];

  it('__custom không hợp lệ khi sàn không nhận tên trục tự đặt, hợp lệ khi caps null hoặc nhận', () => {
    const spec = { ...base, axisMap: { a1: CUSTOM_AXIS } };
    expect(specMissing({ spec, attributes: [], axes, caps: lazadaCaps })).toEqual([{ code: 'a1', label: 'Màu', reason: 'axis_unmapped' }]);
    expect(specMissing({ spec, attributes: [], axes, caps: tiktokCaps })).toEqual([]);
    expect(specMissing({ spec, attributes: [], axes })).toEqual([]);
  });

  it('sales_required: mã bắt buộc chưa có trong axisMap', () => {
    const caps = { ...lazadaCaps, salesRequired: ['color_family'] };
    const attributes = [sales('color_family', 'Màu sắc')];
    expect(specMissing({ spec: { ...base, axisMap: {} }, attributes, axes: [], caps })).toEqual([
      { code: 'color_family', label: 'Màu sắc', reason: 'sales_required' },
    ]);
    expect(specMissing({ spec: { ...base, axisMap: { a1: 'color_family' } }, attributes, axes, caps })).toEqual([]);
  });

  it('axis_shape: nhiều trục hơn category nhận', () => {
    const two = [...axes, { attributeId: 'a2', name: 'Cỡ' }];
    const spec = { ...base, axisMap: { a1: CUSTOM_AXIS, a2: CUSTOM_AXIS } };
    expect(specMissing({ spec, attributes: [], axes: two, caps: { ...tiktokCaps, maxAxes: 1 } })).toEqual([
      { code: 'axes', label: 'Sản phẩm có 2 trục, category này nhận tối đa 1', reason: 'axis_shape' },
    ]);
  });
});
