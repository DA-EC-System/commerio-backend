// Thứ tự tự điền thông số khi đọc spec và khi đẩy (#509, Documents/21 §18.8.2).
import { describe, expect, it } from 'vitest';
import type { PlatformAttribute } from '#src/modules/channel/channel/domain/product-spec.ts';
import {
  type CatalogSpecValue,
  type FieldMapping,
  numberOption,
  resolveSpecAttributes,
  type ResolveInput,
} from '#src/modules/channel/channel/domain/spec-resolve.ts';

const attr = (over: Partial<PlatformAttribute> & { code: string }): PlatformAttribute => ({
  label: over.code,
  kind: 'property',
  input: 'text',
  options: [],
  allowCustom: true,
  required: false,
  requiredWhen: null,
  isKey: false,
  tier: 'category',
  raw: {},
  ...over,
});

const material = attr({
  code: '100157',
  input: 'multiselect',
  allowCustom: false,
  options: [
    { id: '1000039', label: 'Bông' },
    { id: '1000040', label: 'Polyester' },
  ],
});
const fieldMaterial: CatalogSpecValue = {
  fieldId: 'f-material',
  code: 'material',
  input: 'multiselect',
  optionIds: ['o-cotton', 'o-poly'],
  optionLabels: ['Cotton', 'Polyester'],
  value: null,
};
const mapMaterial = (code: string, priority: number, options: Record<string, string> = {}): FieldMapping => ({
  fieldId: 'f-material',
  attributeCode: code,
  priority,
  options: new Map(Object.entries(options)),
});

const base = (over: Partial<ResolveInput>): ResolveInput => ({
  attributes: [material],
  overrides: {},
  product: { brand: null, originCountry: null, specs: [fieldMaterial] },
  mappings: [mapMaterial('100157', 1, { 'o-cotton': '1000039' })],
  org: null,
  ...over,
});

describe('resolveSpecAttributes', () => {
  it('lấy thông số catalog qua ánh xạ: lựa chọn đã ánh xạ ra mã sàn, lựa chọn chưa ánh xạ khớp theo nhãn', () => {
    const r = resolveSpecAttributes({}, base({}));
    expect(r['100157']).toEqual({ value: ['1000039', '1000040'], source: 'catalog', fieldId: 'f-material' });
  });

  it('ghi đè của người dùng thắng catalog', () => {
    const r = resolveSpecAttributes({}, base({ overrides: { '100157': ['1000040'] } }));
    expect(r['100157']).toEqual({ value: ['1000040'], source: 'override', fieldId: null });
  });

  it('lấy mã priority nhỏ nhất mà leaf có; leaf không có mã nào thì thông số không áp', () => {
    const lazMaterial = attr({ code: 'clothing_material', input: 'select', options: [{ id: '9', label: 'Cotton' }] });
    const mappings = [mapMaterial('material', 1), mapMaterial('clothing_material', 2)];
    const r = resolveSpecAttributes({}, base({ attributes: [lazMaterial], mappings }));
    expect(r['clothing_material']).toEqual({ value: '9', source: 'catalog', fieldId: 'f-material' });
    expect(resolveSpecAttributes({}, base({ attributes: [attr({ code: 'other' })], mappings }))).toEqual({});
  });

  it('lựa chọn ánh xạ trỏ mã không có ở leaf này, không khớp nhãn, sàn không cho tự đặt: bỏ', () => {
    const leaf = attr({ code: '100157', input: 'select', allowCustom: false, options: [{ id: '7', label: 'Len' }] });
    const r = resolveSpecAttributes({}, base({ attributes: [leaf] }));
    expect(r['100157']).toBeUndefined();
  });

  it('sàn cho tự đặt: lựa chọn không khớp gửi nhãn; multiselect vào attribute chọn một lấy lựa chọn đầu', () => {
    const leaf = attr({ code: '100157', input: 'select', allowCustom: true, options: [{ id: '7', label: 'Len' }] });
    const r = resolveSpecAttributes({}, base({ attributes: [leaf], mappings: [mapMaterial('100157', 1)] }));
    expect(r['100157']?.value).toBe('Cotton');
  });

  it('không ánh xạ vào attribute sales, tier company, tier product', () => {
    const leaf = [attr({ code: 's', kind: 'sales' }), attr({ code: 'c', tier: 'company' }), attr({ code: 'p', tier: 'product' })];
    const mappings = ['s', 'c', 'p'].map((c, i) => mapMaterial(c, i + 1));
    expect(resolveSpecAttributes({}, base({ attributes: leaf, mappings }))).toEqual({});
  });

  it('number vào attribute có lựa chọn khoảng; date đổi sang định dạng sàn', () => {
    const cap = attr({ code: 'cap', input: 'select', allowCustom: false, options: [{ id: 'a', label: '5000-10000 mAh' }, { id: 'b', label: '10001-15000 mAh' }] });
    const date = attr({ code: '103000' });
    const specs: CatalogSpecValue[] = [
      { fieldId: 'f-cap', code: 'capacity', input: 'number', optionIds: [], optionLabels: [], value: '12000' },
      { fieldId: 'f-date', code: 'license_date', input: 'date', optionIds: [], optionLabels: [], value: '2025-03-09' },
    ];
    const mappings: FieldMapping[] = [
      { fieldId: 'f-cap', attributeCode: 'cap', priority: 1, options: new Map() },
      { fieldId: 'f-date', attributeCode: '103000', priority: 1, options: new Map() },
    ];
    const r = resolveSpecAttributes({}, { attributes: [cap, date], overrides: {}, product: { brand: null, originCountry: null, specs }, mappings, org: null });
    expect(r['cap']?.value).toBe('b');
    expect(r['103000']?.value).toBe('09/03/2025');
  });

  it('thương hiệu: ghi đè riêng sàn thắng catalog; catalog thắng mặc định sàn; hồ sơ công ty cho tier company', () => {
    const adapter = { productFields: { brand: 'brand' as const }, responsibleFields: { '102872': 'name' }, defaultBrand: 'No Brand' };
    const overridden = resolveSpecAttributes(adapter, base({ overrides: { brand: 'Riêng sàn' }, product: { brand: 'Acme', originCountry: null, specs: [] } }));
    expect(overridden['brand']).toEqual({ value: 'Riêng sàn', source: 'override', fieldId: null });
    const withBrand = resolveSpecAttributes(adapter, base({ product: { brand: 'Acme', originCountry: null, specs: [] }, org: { name: 'Cty A' } }));
    expect(withBrand['brand']).toEqual({ value: 'Acme', source: 'catalog', fieldId: null });
    expect(withBrand['102872']).toEqual({ value: 'Cty A', source: 'company', fieldId: null });
    const empty = resolveSpecAttributes(adapter, base({ product: { brand: null, originCountry: null, specs: [] } }));
    expect(empty['brand']).toEqual({ value: 'No Brand', source: 'default', fieldId: null });
  });

  it('leaf chưa lấy: chỉ ghi đè, thương hiệu, hồ sơ công ty', () => {
    const r = resolveSpecAttributes({ productFields: { brand: 'brand' } }, base({ attributes: null, overrides: { x: 'y' }, product: { brand: 'Acme', originCountry: 'VN', specs: [fieldMaterial] } }));
    expect(Object.keys(r).sort()).toEqual(['brand', 'x']);
  });
});

describe('numberOption', () => {
  it('khớp số đúng bằng nhãn, bỏ dấu ngăn nghìn', () => {
    expect(numberOption({ options: [{ id: '1', label: '1.000 ml' }, { id: '2', label: '500 ml' }] }, '1000')).toBe('1');
    expect(numberOption({ options: [{ id: '2', label: '500 ml' }] }, '700')).toBeNull();
  });
});
