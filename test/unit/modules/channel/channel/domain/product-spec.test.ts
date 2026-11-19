// Luật thuần của category, attribute sàn và spec sản phẩm (#400 lát 2): bỏ dấu, khớp lựa chọn (A9), phần còn thiếu
// (`missing`, AC-7, AC-14), gộp quyền TikTok (A17), đổi ISO → giá trị xuất xứ của sàn (A19, AC-15).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  countryOption,
  CUSTOM_AXIS,
  isoOfCountryLabel,
  NOT_COUNTRY_LABELS,
  normalizePath,
  permissionOf,
  type PlatformAttribute,
  resolveOption,
  specMissing,
} from '#src/modules/channel/channel/domain/product-spec.ts';

const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/channel', name), 'utf8')) as T;

interface LazadaRawAttr {
  name: string;
  options?: { id: number; name: string; en_name: string }[];
}
interface TiktokRawAttr {
  id: string;
  values?: { id: string; name: string }[];
}
const lazadaAttrs = (id: string) => fixture<{ data: LazadaRawAttr[] }>(`lazada-attrs-${id}.json`).data;
const tiktokAttrs = fixture<Record<string, { attributes: TiktokRawAttr[] }>>('tiktok-attrs.json');

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

describe('normalizePath', () => {
  it.each([
    ['Đồng hồ', 'dong ho'],
    ['Áo thun', 'ao thun'],
    ['Thời trang  >  Áo   thun NAM', 'thoi trang > ao thun nam'],
    ['ĐẦM đẹp', 'dam dep'],
  ])('%s → %s', (input, expected) => {
    expect(normalizePath(input)).toBe(expected);
  });
});

describe('resolveOption (A9)', () => {
  const raw = lazadaAttrs('7930').find((a) => a.name === 'clothing_material')!;
  const material = attr({
    code: 'clothing_material',
    input: 'select',
    allowCustom: false,
    options: raw.options!.map((o) => ({ id: String(o.id), label: o.name })),
    raw: raw as unknown as Record<string, unknown>,
  });

  it('khớp mã lựa chọn', () => expect(resolveOption(material, '8544')).toBe('8544'));
  it('khớp nhãn tiếng Việt, không phân biệt hoa thường', () => expect(resolveOption(material, ' nhung ')).toBe('8544'));
  it('khớp tên tiếng Anh của bản gốc (Lazada /product/item/get trả "Velvet")', () => {
    expect(resolveOption(material, 'VELVET')).toBe('8544');
  });
  it('nhãn tiếng Anh "Stainless Steel" ra mã lựa chọn', () => {
    const a = attr({
      code: 'material',
      options: [{ id: '101', label: 'Thép không gỉ' }],
      raw: { options: [{ id: 101, name: 'Thép không gỉ', en_name: 'Stainless Steel' }] },
    });
    expect(resolveOption(a, 'Stainless Steel')).toBe('101');
  });
  it('không khớp hoặc rỗng thì null', () => {
    expect(resolveOption(material, 'Lụa tơ tằm giả')).toBeNull();
    expect(resolveOption(material, '  ')).toBeNull();
  });
});

describe('specMissing', () => {
  const base = { attributes: {}, axisMap: {}, categoryStatus: 'ok' as const };

  it('attribute bắt buộc chưa có giá trị → required; có giá trị (cả mảng) thì không', () => {
    const attrs = [attr({ code: 'fa_pattern', label: 'Hoạ tiết', required: true }), attr({ code: 'occasion', required: true })];
    expect(specMissing({ spec: { ...base, attributes: { occasion: ['1', ''] } }, attributes: attrs, axes: [] })).toEqual([
      { code: 'fa_pattern', label: 'Hoạ tiết', reason: 'required' },
    ]);
  });

  it('bắt buộc theo điều kiện chỉ khi attribute điều kiện mang giá trị kích hoạt', () => {
    const attrs = [attr({ code: 'B', label: 'Giấy phép', requiredWhen: [{ code: 'A', values: ['yes'] }] })];
    expect(specMissing({ spec: { ...base, attributes: { A: 'no' } }, attributes: attrs, axes: [] })).toEqual([]);
    expect(specMissing({ spec: { ...base, attributes: { A: 'yes' } }, attributes: attrs, axes: [] })).toEqual([
      { code: 'B', label: 'Giấy phép', reason: 'required_when' },
    ]);
  });

  it('sales attribute bắt buộc không tính required, chỉ kiểm qua trục', () => {
    const attrs = [attr({ code: 'color_family', kind: 'sales', required: true })];
    expect(specMissing({ spec: base, attributes: attrs, axes: [] })).toEqual([]);
  });

  it('trục chưa ánh xạ hoặc trỏ tới sales attribute leaf không còn → axis_unmapped; __custom là đủ', () => {
    const attrs = [attr({ code: 'size', kind: 'sales' })];
    const axes = [
      { attributeId: 'a1', name: 'Màu' },
      { attributeId: 'a2', name: 'Cỡ' },
      { attributeId: 'a3', name: 'Chất liệu' },
    ];
    const spec = { ...base, axisMap: { a1: CUSTOM_AXIS, a2: 'size', a3: 'color_family' } };
    expect(specMissing({ spec, attributes: attrs, axes })).toEqual([{ code: 'a3', label: 'Chất liệu', reason: 'axis_unmapped' }]);
    expect(specMissing({ spec: base, attributes: attrs, axes: axes.slice(0, 1) })).toEqual([
      { code: 'a1', label: 'Màu', reason: 'axis_unmapped' },
    ]);
  });

  it('leaf chưa có attribute (null): chỉ kiểm category và trục có khoá', () => {
    const axes = [{ attributeId: 'a1', name: 'Màu' }];
    expect(specMissing({ spec: { ...base, axisMap: { a1: 'whatever' } }, attributes: null, axes })).toEqual([]);
    expect(specMissing({ spec: base, attributes: null, axes })).toHaveLength(1);
  });

  it('category đổi hay bị bỏ đứng đầu danh sách', () => {
    expect(specMissing({ spec: { ...base, categoryStatus: 'changed' }, attributes: [], axes: [] })[0]).toMatchObject({
      reason: 'category_changed',
    });
    expect(specMissing({ spec: { ...base, categoryStatus: 'removed' }, attributes: [], axes: [] })[0]).toMatchObject({
      reason: 'category_removed',
    });
  });

  it('thương hiệu (tier product) có giá trị dự phòng "No Brand" nên không bao giờ thiếu; hồ sơ công ty cũng vậy', () => {
    const attrs = [
      attr({ code: 'brand', tier: 'product', required: true, input: 'select' }),
      attr({ code: '101489', tier: 'company', required: true }),
      attr({ code: '100149', tier: 'product', required: true }),
    ];
    const missing = specMissing({ spec: base, attributes: attrs, axes: [], fallbacks: { brand: 'No Brand', '101489': 'Công ty A' } });
    expect(missing.map((m) => m.code)).toEqual(['100149']);
  });
});

describe('permissionOf (A17)', () => {
  it.each([
    [['AVAILABLE'], 'available'],
    [['INVITE_ONLY', 'AVAILABLE'], 'available'],
    [['NON_MAIN_CATEGORY', 'INVITE_ONLY'], 'invite_only'],
    [['NON_MAIN_CATEGORY', 'PROHIBITED', 'INVITE_ONLY'], 'prohibited'],
    [['NON_MAIN_CATEGORY'], 'non_main_category'],
    [[], null],
    [['SOMETHING_NEW'], null],
  ])('%j → %s', (statuses, expected) => {
    expect(permissionOf(statuses)).toBe(expected);
  });
});

describe('xuất xứ: ISO ↔ giá trị sàn (A19)', () => {
  const ttValues = tiktokAttrs['601226']!.attributes.find((a) => a.id === '100149')!.values!;
  const lzOptions = (id: string) => lazadaAttrs(id).find((a) => a.name === 'country_origin_hb')!.options!;

  it('fixture đủ số giá trị đo 18/11/2026', () => {
    expect(ttValues).toHaveLength(203);
    expect(lzOptions('7930')).toHaveLength(247);
    expect(lzOptions('4640')).toHaveLength(249);
  });

  it('mọi giá trị TikTok 100149 ứng đúng một mã ISO hoặc nằm trong danh sách "không phải nước"', () => {
    const unknown = ttValues.filter((v) => isoOfCountryLabel(v.name) === null && !NOT_COUNTRY_LABELS.has(normalizePath(v.name)));
    expect(unknown.map((v) => v.name)).toEqual([]);
  });

  it.each(['4640', '6371', '7930'])('mọi lựa chọn Lazada country_origin_hb (%s) ứng một mã ISO hoặc "không phải nước"', (id) => {
    const unknown = lzOptions(id).filter(
      (o) => isoOfCountryLabel(o.name, o.en_name) === null && !NOT_COUNTRY_LABELS.has(normalizePath(o.name)),
    );
    expect(unknown.map((o) => o.name)).toEqual([]);
  });

  it('"Khác/Other", "Châu Âu" không bao giờ là nước', () => {
    expect(isoOfCountryLabel('Khác', 'Other')).toBeNull();
    expect(isoOfCountryLabel('Châu Âu')).toBeNull();
  });

  const tt = ttValues.map((v) => ({ id: v.id, label: v.name }));
  const lz = lzOptions('7930').map((o) => ({ id: String(o.id), label: o.name, enLabel: o.en_name }));
  const labelOf = (opts: { id: string; label: string }[], id: string | null) => opts.find((o) => o.id === id)?.label;

  it.each([
    ['VN', 'Việt Nam'],
    ['US', 'Hoa Kỳ'],
    ['IT', 'Ý'],
    ['TR', 'Gà tây'],
    ['KR', 'Hàn Quốc'],
  ])('TikTok %s → "%s"', (iso, label) => {
    expect(labelOf(tt, countryOption(iso, tt))).toBe(label);
  });

  it.each([
    ['CN', 'Trung Quốc'],
    ['CZ', 'Cộng hòa Séc'],
    ['VN', 'Việt Nam'],
  ])('Lazada %s → "%s"', (iso, label) => {
    expect(labelOf(lz, countryOption(iso, lz))).toBe(label);
  });

  it('GB chọn "Vương quốc Anh" (khớp Intl), không chọn "Anh"/"Scotland" (bí danh)', () => {
    const id = countryOption('GB', lz);
    expect(labelOf(lz, id)).not.toMatch(/^(Anh|Scotland)$/);
    expect(isoOfCountryLabel(labelOf(lz, id)!)).toBe('GB');
  });

  it('mã không có trên sàn hoặc sai dạng thì null (không đoán)', () => {
    expect(countryOption('AQ', [{ id: '1', label: 'Việt Nam' }])).toBeNull();
    expect(countryOption('vietnam', tt)).toBeNull();
    expect(countryOption('', tt)).toBeNull();
  });
});
