import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PlatformAttribute } from '#src/modules/channel/channel/domain/product-spec.ts';
import { lazadaLeafAttributes } from '#src/modules/channel/channel/service/marketplaces/lazada-categories.ts';
import { createLazadaAdapter } from '#src/modules/channel/channel/service/marketplaces/lazada.ts';
import { tiktokLeafAttributes } from '#src/modules/channel/channel/service/marketplaces/tiktok-categories.ts';
import { createTiktokAdapter } from '#src/modules/channel/channel/service/marketplaces/tiktok.ts';
import { normalizeSpec, pushAttributes, specFallbacks, type SpecProduct } from '#src/modules/channel/channel/service/product-specs.ts';

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

// Giá trị gửi lên sàn (review BE2 P1-2, AC-13, AC-15): attribute leaf dựng bằng chính hàm chuẩn hoá của adapter trên phản hồi
// gọi thật (fixture), adapter thật (`productFields`, `defaultBrand`). Spec lưu mã lựa chọn; lên sàn là nhãn của sàn (adapter
// TikTok tự đổi nhãn về `id`, Lazada gửi nhãn); xuất xứ, thương hiệu lấy ở catalog.
const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/channel', name), 'utf8')) as T;
const lazadaLeaf = lazadaLeafAttributes(fixture<{ data: unknown }>('lazada-attrs-7930.json').data);
const tiktokLeaf = tiktokLeafAttributes(fixture<Record<string, { attributes: Record<string, unknown>[] }>>('tiktok-attrs.json')['601226']!.attributes);
const lazada = createLazadaAdapter({ appKey: 'k', appSecret: 's', redirectUrl: undefined, apiUrl: 'https://api.test/rest', authUrl: 'https://auth.test' }, vi.fn());
const tiktok = createTiktokAdapter({ appKey: 'k', appSecret: 's', serviceId: 'svc', apiUrl: 'https://api.test', authUrl: 'https://auth.test' } as never, vi.fn());
const noCatalog = { originCountry: null, brand: null };

describe('pushAttributes: Lazada', () => {
  it('select đổi mã → nhãn sàn; multiselect thành mảng nhãn; nhãn cũ của bản chép giữ nguyên; xuất xứ, thương hiệu theo catalog', () => {
    const spec = { attributes: { clothing_material: '9937', occasion: ['2167', '3015'], Fit_Type: 'Thường xuyên', brand: 'Cũ' } };
    expect(pushAttributes(lazada, lazadaLeaf, spec, { originCountry: 'VN', brand: 'Acme' })).toEqual({
      clothing_material: 'Denim',
      occasion: ['Thể thao', 'Bình thường'],
      Fit_Type: 'Thường xuyên',
      brand: 'Acme',
      country_origin_hb: 'Việt Nam',
    });
  });

  it('catalog trống: giữ khoá thương hiệu, xuất xứ của bản chép; không có khoá thì không gửi (adapter tự điền thương hiệu mặc định)', () => {
    expect(pushAttributes(lazada, lazadaLeaf, { attributes: { brand: 'Cũ', country_origin_hb: 'Nhật Bản' } }, noCatalog)).toEqual({
      brand: 'Cũ',
      country_origin_hb: 'Nhật Bản',
    });
    expect(pushAttributes(lazada, lazadaLeaf, { attributes: {} }, noCatalog)).toEqual({});
  });

  it('xuất xứ của catalog không đổi được ra lựa chọn sàn: không gửi giá trị đoán', () => {
    expect(pushAttributes(lazada, lazadaLeaf, { attributes: {} }, { originCountry: 'ZZ', brand: null })).toEqual({});
  });

  it('chưa có attribute leaf: gửi nguyên giá trị đã lưu, thương hiệu catalog vẫn thắng', () => {
    expect(pushAttributes(lazada, null, { attributes: { clothing_material: '9937', brand: 'Cũ' } }, { originCountry: 'VN', brand: 'Acme' })).toEqual({
      clothing_material: '9937',
      brand: 'Acme',
    });
  });
});

describe('pushAttributes: TikTok', () => {
  it('select, multiselect đổi mã → nhãn; 100149 lấy từ originCountry của catalog, thắng khoá của bản chép', () => {
    const spec = { attributes: { '100395': '1001141', '100157': ['1000039', '1000044'], '100149': 'Việt Nam' } };
    expect(pushAttributes(tiktok, tiktokLeaf, spec, { originCountry: 'US', brand: null })).toEqual({
      '100395': 'Ngắn tay',
      '100157': ['Bông', 'Lụa'],
      '100149': 'Hoa Kỳ',
    });
  });

  it('catalog trống: dùng khoá 100149 còn trong bản chép; không có thì không gửi', () => {
    expect(pushAttributes(tiktok, tiktokLeaf, { attributes: { '100149': 'Việt Nam' } }, noCatalog)).toEqual({ '100149': 'Việt Nam' });
    expect(pushAttributes(tiktok, tiktokLeaf, { attributes: {} }, noCatalog)).toEqual({});
  });

  it('giá trị tự nhập (không có trong lựa chọn) giữ nguyên chuỗi', () => {
    expect(pushAttributes(tiktok, tiktokLeaf, { attributes: { '100395': 'Tay cánh tiên' } }, noCatalog)).toEqual({ '100395': 'Tay cánh tiên' });
  });
});

describe('specFallbacks', () => {
  it('Lazada: thương hiệu catalog, trống thì "No Brand"; xuất xứ ISO → mã lựa chọn của sàn', () => {
    expect(specFallbacks(lazada, lazadaLeaf, { originCountry: 'VN', brand: null }, null)).toEqual({ brand: 'No Brand', country_origin_hb: '61613' });
    expect(specFallbacks(lazada, lazadaLeaf, { originCountry: null, brand: 'Acme' }, null)).toEqual({ brand: 'Acme', country_origin_hb: null });
  });

  it('TikTok: 100149 từ originCountry; hồ sơ công ty điền attribute tier company', () => {
    const out = specFallbacks(tiktok, tiktokLeaf, { originCountry: 'VN', brand: null }, { name: 'Công ty A', address: 'Số 1 Đường B' } as never);
    expect(out['100149']).toBe('1000854');
    expect(out['101489']).toBe('Công ty A');
    expect(specFallbacks(tiktok, tiktokLeaf, noCatalog, null)['100149']).toBeNull();
  });
});
