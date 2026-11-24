import { describe, expect, it } from 'vitest';
import {
  appPushError,
  type PlatformFailure,
  type PushErrorContext,
  type PlatformErrorRule,
  translatePlatformError,
} from '#src/modules/channel/channel/domain/platform-error.ts';
import { LAZADA_PUSH_ERRORS } from '#src/modules/channel/channel/service/marketplaces/lazada-push-errors.ts';
import { TIKTOK_PUSH_ERRORS } from '#src/modules/channel/channel/service/marketplaces/tiktok-push-errors.ts';

const ctx = (over: Partial<PushErrorContext> = {}): PushErrorContext => ({
  platformName: 'Lazada',
  attributeLabel: (code) => ({ weight: 'Trọng lượng', brand: 'Thương hiệu', color_family: 'Màu' })[code] ?? null,
  axisAttributeId: () => null,
  ...over,
});

const failure = (over: Partial<PlatformFailure>): PlatformFailure => ({ platformCode: null, platformMessage: null, details: [], ...over });

// Câu thật trên staging (issue #567, ca đêm 18/11/2026, gọi thật 17/11/2026).
const MEASURE = failure({
  platformCode: '4110',
  platformMessage: 'E500: Create product failed (Product: BIZ_CHECK_MEASURE_PROP_TEXT_INVALID:Giá trị thuộc tính đo lường weight không phải là số hợp lệ!)',
  details: [{ field: 'Product', code: 'BIZ_CHECK_MEASURE_PROP_TEXT_INVALID', message: 'Giá trị thuộc tính đo lường weight không phải là số hợp lệ!' }],
});
const PACKAGE_WEIGHT = failure({
  platformCode: '4110',
  platformMessage: 'E500: Create product failed',
  details: [{ field: 'Product', code: 'BIZ_CHECK_PACKAGE_WEIGHT_BY_KG_INVALID', message: 'Khối lượng kiện hàng nên nằm trong khoảng 0.001 và 300.0' }],
});
const BRAND = failure({
  platformCode: '4110',
  platformMessage: 'E500: Create product failed',
  details: [{ field: 'brandProp', code: 'BIZ_CHECK_CAT_PROP_MANDATORY', message: 'C006:Vui lòng điền Brand trước khi tải lên lại.' }],
});

describe('translatePlatformError: Lazada', () => {
  it('MEASURE_PROP là lỗi giá trị attribute, chỉ ô attribute, không phải cân nặng SKU', () => {
    const out = translatePlatformError(LAZADA_PUSH_ERRORS, MEASURE, ctx());
    expect(out).toEqual({
      code: 'attribute_value_invalid',
      kind: 'data',
      message: 'Giá trị của thuộc tính Trọng lượng phải là số kèm đơn vị, vd 500 g',
      target: { kind: 'spec_attribute', attributeCode: 'weight' },
      platformCode: 'BIZ_CHECK_MEASURE_PROP_TEXT_INVALID',
      platformMessage: 'Giá trị thuộc tính đo lường weight không phải là số hợp lệ!',
      mapped: true,
    });
    expect(out.message).not.toContain('E500');
  });

  it('MEASURE_PROP trên attribute là thuộc tính biến thể của sản phẩm thì chỉ phần ánh xạ', () => {
    const out = translatePlatformError(LAZADA_PUSH_ERRORS, MEASURE, ctx({ axisAttributeId: (c) => (c === 'weight' ? 'attr-1' : null) }));
    expect(out.target).toEqual({ kind: 'axis', attributeId: 'attr-1' });
  });

  it('PACKAGE_WEIGHT là cân nặng kiện của SKU, số viết kiểu Việt', () => {
    const out = translatePlatformError(LAZADA_PUSH_ERRORS, PACKAGE_WEIGHT, ctx());
    expect(out).toMatchObject({
      code: 'weight_out_of_range',
      kind: 'data',
      message: 'Cân nặng kiện hàng phải từ 0,001 đến 300 kg theo sàn',
      target: { kind: 'variant_field', field: 'weight' },
      platformCode: 'BIZ_CHECK_PACKAGE_WEIGHT_BY_KG_INVALID',
    });
  });

  it('thiếu attribute bắt buộc: suy mã từ field (brandProp), C006 không thành mã', () => {
    const out = translatePlatformError(LAZADA_PUSH_ERRORS, BRAND, ctx());
    expect(out).toMatchObject({
      code: 'attribute_required',
      message: 'Thiếu Thương hiệu bắt buộc của category',
      target: { kind: 'spec_attribute', attributeCode: 'brand' },
      platformCode: 'BIZ_CHECK_CAT_PROP_MANDATORY',
      platformMessage: 'C006:Vui lòng điền Brand trước khi tải lên lại.',
    });
  });

  it('nhiều detail: lấy detail đầu khớp luật', () => {
    const f = failure({
      platformCode: '4110',
      details: [{ field: 'x', code: 'BIZ_UNKNOWN_THING', message: 'lạ' }, ...PACKAGE_WEIGHT.details],
    });
    expect(translatePlatformError(LAZADA_PUSH_ERRORS, f, ctx()).code).toBe('weight_out_of_range');
  });

  it('khớp mã ngoài cùng khi không có detail (4134 không phải category lá)', () => {
    const out = translatePlatformError(LAZADA_PUSH_ERRORS, failure({ platformCode: '4134', platformMessage: 'not leaf' }), ctx());
    expect(out).toMatchObject({ code: 'category_not_leaf', kind: 'data', target: { kind: 'category' }, platformCode: '4134' });
  });
});

describe('translatePlatformError: mã chưa có trong bảng', () => {
  it('câu chung có tên sàn, câu gốc của detail, mapped false', () => {
    const f = failure({ platformCode: '4110', platformMessage: 'E500: Create product failed (Product: BIZ_NEW:Câu mới)', details: [{ field: 'Product', code: 'BIZ_NEW', message: 'Câu mới' }] });
    expect(translatePlatformError(LAZADA_PUSH_ERRORS, f, ctx())).toEqual({
      code: 'marketplace_rejected',
      kind: 'platform',
      message: 'Lazada không nhận sản phẩm: Câu mới',
      target: null,
      platformCode: 'BIZ_NEW',
      platformMessage: 'Câu mới',
      mapped: false,
    });
  });

  it('field khớp attribute của spec thì vẫn suy spec_attribute, kind data', () => {
    const f = failure({ platformCode: '4110', details: [{ field: 'color_familyProp', code: 'BIZ_NEW', message: 'sai màu' }] });
    expect(translatePlatformError(LAZADA_PUSH_ERRORS, f, ctx())).toMatchObject({
      code: 'marketplace_rejected',
      kind: 'data',
      target: { kind: 'spec_attribute', attributeCode: 'color_family' },
    });
  });

  it('không có detail, không có câu: không ném, dùng mã ngoài', () => {
    const out = translatePlatformError(LAZADA_PUSH_ERRORS, failure({ platformCode: '999' }), ctx());
    expect(out).toMatchObject({ code: 'marketplace_rejected', platformCode: '999', message: 'Lazada không nhận sản phẩm (mã 999)' });
  });

  it('detail không có code: giữ mã ngoài, câu của detail', () => {
    const out = translatePlatformError(LAZADA_PUSH_ERRORS, failure({ platformCode: '4110', platformMessage: 'E500', details: [{ field: null, code: null, message: 'lý do' }] }), ctx());
    expect(out).toMatchObject({ platformCode: '4110', platformMessage: 'lý do', message: 'Lazada không nhận sản phẩm: lý do' });
  });
});

describe('translatePlatformError: TikTok và mã kiểm trước', () => {
  const tt = ctx({ platformName: 'TikTok Shop', attributeLabel: (c) => (c === '100149' ? 'Quốc gia xuất xứ' : null) });

  it('12052051 trong listing_check thắng mã kiểm trước', () => {
    const f = failure({
      platformCode: 'listing_check_failed',
      platformMessage: '12052051: product name must be between 25 and 255 characters',
      details: [{ field: null, code: '12052051', message: 'product name must be between 25 and 255 characters' }],
    });
    expect(translatePlatformError(TIKTOK_PUSH_ERRORS, f, tt)).toMatchObject({
      code: 'name_length',
      kind: 'data',
      target: { kind: 'product_field', field: 'name' },
      platformCode: '12052051',
    });
  });

  it('12052104 nêu mã attribute trong câu thì chỉ ô đó', () => {
    const f = failure({ platformCode: '12052104', platformMessage: 'attribute 100149 is required' });
    expect(translatePlatformError(TIKTOK_PUSH_ERRORS, f, tt)).toMatchObject({
      code: 'attribute_required',
      message: 'Thiếu Quốc gia xuất xứ bắt buộc của category',
      target: { kind: 'spec_attribute', attributeCode: '100149' },
    });
  });

  it('listing_check_failed không detail nào khớp: giữ mã, kind data', () => {
    const f = failure({ platformCode: 'listing_check_failed', platformMessage: '1: x', details: [{ field: null, code: '1', message: 'x' }] });
    expect(translatePlatformError(TIKTOK_PUSH_ERRORS, f, tt)).toMatchObject({ code: 'listing_check_failed', kind: 'data', mapped: true });
  });

  it('shop_not_eligible là platform', () => {
    const f = failure({ platformCode: 'shop_not_eligible', platformMessage: 'Chưa có kho trả hàng' });
    expect(translatePlatformError(TIKTOK_PUSH_ERRORS, f, tt)).toMatchObject({
      code: 'shop_not_eligible',
      kind: 'platform',
      message: 'Gian hàng TikTok Shop chưa đủ điều kiện đăng bán: Chưa có kho trả hàng. Hoàn tất trên Seller Center rồi đăng lại',
    });
  });
});

describe('translatePlatformError: luật bằng RegExp, field', () => {
  const rules: PlatformErrorRule[] = [
    { platformCode: /^41(38|39)$/, field: 'image', code: 'images_missing', kind: 'data', message: 'Ảnh', target: { kind: 'product_field', field: 'images' } },
  ];
  it('field khác thì không khớp', () => {
    const f = failure({ platformCode: '4110', details: [{ field: 'name', code: '4139', message: 'm' }] });
    expect(translatePlatformError(rules, f, ctx()).mapped).toBe(false);
  });
  it('field đúng thì khớp', () => {
    const f = failure({ platformCode: '4110', details: [{ field: 'image', code: '4139', message: 'm' }] });
    expect(translatePlatformError(rules, f, ctx()).code).toBe('images_missing');
  });
});

describe('appPushError: mã của app có kind và chỗ sửa', () => {
  it.each([
    ['price_missing', 'data', { kind: 'variant_field', field: 'price' }],
    ['dimensions_missing', 'data', { kind: 'variant_field', field: 'dimensions' }],
    ['images_missing', 'data', { kind: 'product_field', field: 'images' }],
    ['category_unmapped', 'data', { kind: 'category' }],
    ['category_not_permitted', 'platform', { kind: 'shop', field: 'category_permission' }],
    ['marketplace_unavailable', 'connection', null],
    ['shop_not_connected', 'connection', null],
    ['sku_exists_on_platform', 'platform', null],
  ] as const)('%s', (code, kind, target) => {
    expect(appPushError(code)).toEqual({ kind, target });
  });
});
