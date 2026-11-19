import { describe, expect, it } from 'vitest';
import type { PlatformAttribute } from '#src/modules/channel/channel/domain/product-spec.ts';
import { normalizeSpec, type SpecProduct } from '#src/modules/channel/channel/service/product-specs.ts';

// Attribute cascade trong spec (#400, Documents/21 §18.5, thêm 19/11/2026): lưu `path` tới cấp cuối, bắt buộc như mọi attribute.
const cascade: PlatformAttribute = {
  code: 'propCascade',
  label: 'Nơi sản xuất',
  kind: 'property',
  input: 'cascade',
  options: [],
  allowCustom: false,
  required: true,
  requiredWhen: null,
  isKey: false,
  tier: 'category',
  raw: { id: 35 },
};
const product: SpecProduct = { axes: [], valueIds: new Map(), originCountry: null, brand: null };
const run = (value: string | string[] | undefined, attr = cascade) =>
  normalizeSpec({ externalCategoryId: 'L', attributes: value === undefined ? {} : { propCascade: value }, axisMap: {}, valueMap: {}, version: null }, [attr], product, {});

describe('normalizeSpec: cascade', () => {
  it('path hợp lệ lưu nguyên', () => {
    const path = '120013644:162,100006867:160387;120013642:163';
    expect(run(path)).toEqual({ values: { attributes: { propCascade: path }, axisMap: {}, valueMap: {} }, errors: {} });
  });

  it('bắt buộc mà trống: lỗi theo ô (không bỏ qua cascade)', () => {
    expect(run(undefined).errors['attributes.propCascade']).toBeDefined();
    expect(run('').errors['attributes.propCascade']).toBeDefined();
  });

  it('không bắt buộc mà trống: không lỗi, không lưu', () => {
    expect(run(undefined, { ...cascade, required: false })).toMatchObject({ values: { attributes: {} }, errors: {} });
  });

  it('sai định dạng hoặc gửi mảng: lỗi theo ô', () => {
    expect(run('Hà Nội').errors['attributes.propCascade']).toBeDefined();
    expect(run(['1:2', '3:4']).errors['attributes.propCascade']).toBeDefined();
  });
});
