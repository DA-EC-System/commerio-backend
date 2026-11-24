import { describe, expect, it } from 'vitest';
import {
  axisGroups,
  combinable,
  combineTarget,
  joinValues,
  targetCombinable,
} from '#src/modules/channel/channel/domain/axis-combine.ts';
import type { PlatformAttribute } from '#src/modules/channel/channel/domain/product-spec.ts';

// Thuộc tính biến thể ghép (commerio-backend#568, Documents/21 §18.8.3).
const attr = (over: Partial<PlatformAttribute> & { code: string }): PlatformAttribute => ({
  label: over.code,
  kind: 'sales',
  input: 'select',
  options: [],
  allowCustom: true,
  required: false,
  requiredWhen: null,
  isKey: false,
  tier: 'category',
  raw: {},
  ...over,
});

describe('combinable', () => {
  it('nhận sales attribute nhận chữ ngoài lựa chọn (select, multiselect, text)', () => {
    expect(combinable(attr({ code: 'a', input: 'select' }))).toBe(true);
    expect(combinable(attr({ code: 'a', input: 'multiselect' }))).toBe(true);
    expect(combinable(attr({ code: 'a', input: 'text' }))).toBe(true);
  });

  it('không nhận kiểu số, ngày dù allowCustom (Lazada numeric: leaf 14972 Gia cầm tươi)', () => {
    expect(combinable(attr({ code: 'weight', input: 'number' }))).toBe(false);
    expect(combinable(attr({ code: 'd', input: 'date' }))).toBe(false);
  });

  it('không nhận attribute chỉ nhận lựa chọn có sẵn hoặc không phải sales', () => {
    expect(combinable(attr({ code: 'a', allowCustom: false }))).toBe(false);
    expect(combinable(attr({ code: 'a', kind: 'property' }))).toBe(false);
  });
});

describe('targetCombinable', () => {
  const leaf = [attr({ code: 'color_family' }), attr({ code: 'size', allowCustom: false })];

  it('mã sales attribute theo combinable; mã không có trong leaf thì không', () => {
    expect(targetCombinable('color_family', leaf, null)).toBe(true);
    expect(targetCombinable('size', leaf, null)).toBe(false);
    expect(targetCombinable('lạ', leaf, null)).toBe(false);
  });

  it('__custom theo customAxisName; caps null coi như nhận', () => {
    expect(targetCombinable('__custom', leaf, { customAxisName: true })).toBe(true);
    expect(targetCombinable('__custom', leaf, { customAxisName: false })).toBe(false);
    expect(targetCombinable('__custom', leaf, null)).toBe(true);
  });

  it('leaf chưa lấy attribute thì cho qua', () => {
    expect(targetCombinable('color_family', null, null)).toBe(true);
  });
});

describe('combineTarget', () => {
  it('ưu tiên sale prop bắt buộc ghép được', () => {
    const leaf = [attr({ code: 'color_family' }), attr({ code: 'size', required: true })];
    expect(combineTarget(leaf, { customAxisName: false })).toBe('size');
  });

  it('không có bắt buộc ghép được thì lấy sale prop ghép được đầu tiên', () => {
    const leaf = [
      attr({ code: 'size', required: true, allowCustom: false }),
      attr({ code: 'color_family' }),
      attr({ code: 'scent' }),
    ];
    expect(combineTarget(leaf, { customAxisName: false })).toBe('color_family');
  });

  it('không sale prop nào ghép được thì __custom khi sàn nhận tên tự đặt, không thì null', () => {
    const leaf = [attr({ code: 'weight', input: 'number' })];
    expect(combineTarget(leaf, { customAxisName: true })).toBe('__custom');
    expect(combineTarget(leaf, { customAxisName: false })).toBeNull();
  });

  it('leaf chưa lấy attribute thì null', () => {
    expect(combineTarget(null, { customAxisName: true })).toBeNull();
  });
});

describe('axisGroups', () => {
  it('gom trục cùng đích theo thứ tự trục, bỏ trục chưa ánh xạ', () => {
    expect(
      axisGroups({ a: 'color_family', b: 'size', c: 'color_family' }, ['c', 'x', 'a', 'b']),
    ).toEqual([
      { target: 'color_family', attributeIds: ['c', 'a'] },
      { target: 'size', attributeIds: ['b'] },
    ]);
  });
});

describe('joinValues', () => {
  it('nối nhãn bằng " - "', () => {
    expect(joinValues(['Đỏ', 'S'])).toBe('Đỏ - S');
    expect(joinValues(['Đỏ'])).toBe('Đỏ');
  });
});
