import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { type PlatformAttribute, specMissing } from '#src/modules/channel/channel/domain/product-spec.ts';
import { lazadaLeafAttributes } from '#src/modules/channel/channel/service/marketplaces/lazada-categories.ts';
import { createLazadaAdapter } from '#src/modules/channel/channel/service/marketplaces/lazada.ts';
import { tiktokLeafAttributes } from '#src/modules/channel/channel/service/marketplaces/tiktok-categories.ts';
import { createTiktokAdapter } from '#src/modules/channel/channel/service/marketplaces/tiktok.ts';
import { resolveSpecAttributes } from '#src/modules/channel/channel/domain/spec-resolve.ts';
import { normalizeSpec, pushAttributes, type SpecProduct } from '#src/modules/channel/channel/service/product-specs.ts';

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
const product: SpecProduct = { productId: 'p', axes: [], valueIds: new Map(), variantValues: [], originCountry: null, brand: null };
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

// Giá trị gửi lên sàn (review BE2 P1-2, AC-13, AC-15): attribute leaf dựng bằng chính hàm chuẩn hoá của adapter trên phản hồi
// gọi thật (fixture), adapter thật (`productFields`, `defaultBrand`). Spec lưu mã lựa chọn; lên sàn là nhãn của sàn (adapter
// TikTok tự đổi nhãn về `id`, Lazada gửi nhãn); xuất xứ, thương hiệu lấy ở catalog.
const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/channel', name), 'utf8')) as T;
const lazadaLeaf = lazadaLeafAttributes(fixture<{ data: unknown }>('lazada-attrs-7930.json').data);
const tiktokLeaf = tiktokLeafAttributes(fixture<Record<string, { attributes: Record<string, unknown>[] }>>('tiktok-attrs.json')['601226']!.attributes);
const lazada = createLazadaAdapter({ appKey: 'k', appSecret: 's', redirectUrl: undefined, apiUrl: 'https://api.test/rest', authUrl: 'https://auth.test' }, vi.fn());
const tiktok = createTiktokAdapter({ appKey: 'k', appSecret: 's', serviceId: 'svc', apiUrl: 'https://api.test', authUrl: 'https://auth.test' } as never, vi.fn());
const noCatalog = { originCountry: null, brand: null };

// Giá trị gửi lên sàn là `resolved` (#509, Documents/21 §18.8.2) bỏ phần adapter tự điền (hồ sơ công ty, thương hiệu mặc định),
// select đổi mã → nhãn. Ghi đè thắng catalog, kể cả thương hiệu, xuất xứ (E179).
const push = (
  adapter: typeof lazada,
  leaf: PlatformAttribute[] | null,
  overrides: Record<string, string | string[]>,
  catalog: { originCountry: string | null; brand: string | null },
) => pushAttributes(leaf, resolveSpecAttributes(adapter, { attributes: leaf, overrides, product: { ...catalog, specs: [] }, mappings: [], org: null }));

describe('pushAttributes: Lazada', () => {
  it('select đổi mã → nhãn sàn; multiselect thành mảng nhãn; nhãn cũ giữ nguyên; ghi đè thương hiệu thắng catalog; xuất xứ theo catalog', () => {
    const spec = { clothing_material: '9937', occasion: ['2167', '3015'], Fit_Type: 'Thường xuyên', brand: 'Riêng sàn' };
    expect(push(lazada, lazadaLeaf, spec, { originCountry: 'VN', brand: 'Acme' })).toEqual({
      clothing_material: 'Denim',
      occasion: ['Thể thao', 'Bình thường'],
      Fit_Type: 'Thường xuyên',
      brand: 'Riêng sàn',
      country_origin_hb: 'Việt Nam',
    });
  });

  it('không ghi đè: thương hiệu catalog; catalog trống thì không gửi (adapter tự điền thương hiệu mặc định)', () => {
    expect(push(lazada, lazadaLeaf, {}, { originCountry: null, brand: 'Acme' })).toEqual({ brand: 'Acme' });
    expect(push(lazada, lazadaLeaf, {}, noCatalog)).toEqual({});
  });

  it('xuất xứ của catalog không đổi được ra lựa chọn sàn: không gửi giá trị đoán', () => {
    expect(push(lazada, lazadaLeaf, {}, { originCountry: 'ZZ', brand: null })).toEqual({});
  });

  it('chưa có attribute leaf: gửi nguyên giá trị đã lưu cộng thương hiệu catalog', () => {
    expect(push(lazada, null, { clothing_material: '9937' }, { originCountry: 'VN', brand: 'Acme' })).toEqual({ clothing_material: '9937', brand: 'Acme' });
  });
});

describe('pushAttributes: TikTok', () => {
  it('select, multiselect đổi mã → nhãn; 100149 lấy từ originCountry của catalog khi không ghi đè', () => {
    const spec = { '100395': '1001141', '100157': ['1000039', '1000044'] };
    expect(push(tiktok, tiktokLeaf, spec, { originCountry: 'US', brand: null })).toEqual({
      '100395': 'Ngắn tay',
      '100157': ['Bông', 'Lụa'],
      '100149': 'Hoa Kỳ',
    });
  });

  it('ghi đè 100149 thắng catalog', () => {
    expect(push(tiktok, tiktokLeaf, { '100149': 'Việt Nam' }, { originCountry: 'US', brand: null })).toEqual({ '100149': 'Việt Nam' });
  });

  it('giá trị tự nhập (không có trong lựa chọn) giữ nguyên chuỗi', () => {
    expect(push(tiktok, tiktokLeaf, { '100395': 'Tay cánh tiên' }, noCatalog)).toEqual({ '100395': 'Tay cánh tiên' });
  });
});

describe('resolveSpecAttributes với adapter thật', () => {
  const resolve = (adapter: typeof lazada, leaf: PlatformAttribute[], catalog: { originCountry: string | null; brand: string | null }, org: Record<string, string> | null = null) =>
    resolveSpecAttributes(adapter, { attributes: leaf, overrides: {}, product: { ...catalog, specs: [] }, mappings: [], org });

  it('Lazada: thương hiệu catalog, trống thì "No Brand" (nguồn mặc định); xuất xứ ISO → mã lựa chọn của sàn', () => {
    const out = resolve(lazada, lazadaLeaf, { originCountry: 'VN', brand: null });
    expect(out['brand']).toEqual({ value: 'No Brand', source: 'default', fieldId: null });
    expect(out['country_origin_hb']).toEqual({ value: '61613', source: 'catalog', fieldId: null });
    expect(resolve(lazada, lazadaLeaf, { originCountry: null, brand: 'Acme' })['brand']?.value).toBe('Acme');
  });

  it('TikTok: 100149 từ originCountry; hồ sơ công ty điền attribute tier company', () => {
    const out = resolve(tiktok, tiktokLeaf, { originCountry: 'VN', brand: null }, { name: 'Công ty A', address: 'Số 1 Đường B' });
    expect(out['100149']?.value).toBe('1000854');
    expect(out['101489']).toEqual({ value: 'Công ty A', source: 'company', fieldId: null });
    expect(resolve(tiktok, tiktokLeaf, noCatalog)['100149']).toBeUndefined();
  });
});

describe('normalizeSpec: tập ghi đè (#509)', () => {
  const material: PlatformAttribute = { ...cascade, code: 'm', label: 'Chất liệu', input: 'select', required: false, allowCustom: false, options: [{ id: '1', label: 'Bông' }, { id: '2', label: 'Lụa' }] };
  const put = (attributes: Record<string, string | string[]>, defaults: Record<string, string | string[]>, attr = material) =>
    normalizeSpec({ externalCategoryId: 'L', attributes, axisMap: {}, valueMap: {}, version: null }, [attr], product, defaults);

  it('giá trị trùng nguồn catalog thì không lưu; khác thì lưu thành ghi đè', () => {
    expect(put({ m: 'Bông' }, { m: '1' }).values.attributes).toEqual({});
    expect(put({ m: 'Lụa' }, { m: '1' }).values.attributes).toEqual({ m: '2' });
  });

  it('bắt buộc mà catalog đã có giá trị: không lỗi khi không ghi đè', () => {
    expect(put({}, { m: '1' }, { ...material, required: true }).errors).toEqual({});
    expect(put({}, {}, { ...material, required: true }).errors['attributes.m']).toBeDefined();
  });

  it('ghi đè được attribute tier product (thương hiệu, xuất xứ riêng sàn)', () => {
    expect(put({ m: 'Lụa' }, { m: '1' }, { ...material, tier: 'product' }).values.attributes).toEqual({ m: '2' });
  });
});

// Review BE2 P2-7 (AC-15): attribute `tier = 'product'` (xuất xứ) điền ở trang sản phẩm, ô ở tab spec chỉ đọc. `PUT` không báo
// 422 cho ô đó; `missing` báo kèm nhãn "(điền ở trang sản phẩm)" để FE dẫn sang trang sản phẩm.
describe('attribute tier product (P2-7)', () => {
  const origin: PlatformAttribute = { ...cascade, code: '100149', label: 'Quốc gia xuất xứ', input: 'select', options: [{ id: '1000854', label: 'Việt Nam' }], tier: 'product' };
  it('PUT: catalog chưa có xuất xứ thì không lỗi theo ô, không lưu khoá', () => {
    expect(run(undefined, origin)).toEqual({ values: { attributes: {}, axisMap: {}, valueMap: {} }, errors: {} });
  });

  it('missing: nhãn kèm "(điền ở trang sản phẩm)"; catalog có xuất xứ thì không thiếu', () => {
    const spec = { attributes: {}, axisMap: {}, categoryStatus: 'ok' as const };
    expect(specMissing({ spec, attributes: [origin], axes: [] })).toEqual([{ code: '100149', label: 'Quốc gia xuất xứ (điền ở trang sản phẩm)', reason: 'required' }]);
    expect(specMissing({ spec, attributes: [origin], axes: [], fallbacks: { '100149': '1000854' } })).toEqual([]);
  });
});
