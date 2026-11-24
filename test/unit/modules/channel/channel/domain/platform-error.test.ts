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
    ['axis_shape', 'data', { kind: 'axis' }],
    ['category_not_permitted', 'platform', { kind: 'shop', field: 'category_permission' }],
    ['marketplace_unavailable', 'connection', null],
    ['shop_not_connected', 'connection', null],
    ['sku_exists_on_platform', 'platform', null],
  ] as const)('%s', (code, kind, target) => {
    expect(appPushError(code)).toEqual({ kind, target });
  });
});

// #571: lỗi đẩy tồn, giá theo SKU đi cùng bảng `errorMap`, luật chỉ áp cho thao tác khai ở `ops` (mặc định `push`).
describe('translatePlatformError: thao tác tồn, giá (#571)', () => {
  const lz = ctx();
  const tt = ctx({ platformName: 'TikTok Shop' });
  const sku = (platformCode: string, platformMessage: string | null = 'm') => failure({ platformCode, platformMessage });

  it('luật mặc định chỉ cho đăng: luật đăng không khớp lỗi đồng bộ', () => {
    const rules: PlatformErrorRule[] = [{ platformCode: 'X1', code: 'only_push', kind: 'data', message: 'm' }];
    expect(translatePlatformError(rules, sku('X1'), lz, 'stock').mapped).toBe(false);
    expect(translatePlatformError(rules, sku('X1'), lz, 'push').mapped).toBe(true);
  });

  it('luật khai ops tồn không khớp khi đăng', () => {
    const rules: PlatformErrorRule[] = [{ platformCode: 'X2', ops: ['stock'], code: 'only_stock', kind: 'data', message: 'm' }];
    expect(translatePlatformError(rules, sku('X2'), lz).mapped).toBe(false);
    expect(translatePlatformError(rules, sku('X2'), lz, 'stock').code).toBe('only_stock');
  });

  it('mã chưa có trong bảng: câu theo thao tác, kèm câu sàn', () => {
    expect(translatePlatformError([], sku('999', 'Boom'), lz, 'stock')).toMatchObject({
      code: 'marketplace_rejected',
      kind: 'platform',
      message: 'Lazada không nhận cập nhật tồn: Boom',
      platformCode: '999',
      platformMessage: 'Boom',
      mapped: false,
    });
    expect(translatePlatformError([], sku('999', null), lz, 'price').message).toBe('Lazada không nhận cập nhật giá (mã 999)');
  });

  it('Lazada 4170 khi đẩy tồn là khoá do khuyến mãi, giữ mã gốc', () => {
    const msg = 'During the Bday Mega campaign, … Sellers can increase stocks, but may not decrease stocks.';
    expect(translatePlatformError(LAZADA_PUSH_ERRORS, sku('4170', msg), lz, 'stock')).toMatchObject({
      code: 'promotion_locked',
      kind: 'platform',
      target: null,
      platformCode: '4170',
      platformMessage: msg,
      mapped: true,
    });
    expect(translatePlatformError(LAZADA_PUSH_ERRORS, sku('4170'), lz, 'stock').message).toMatch(/khoá giảm tồn do khuyến mãi/);
  });

  it('Lazada 4225 (bán hộ GSP) khớp cả tồn lẫn giá, là lỗi sàn', () => {
    for (const op of ['stock', 'price'] as const) {
      expect(translatePlatformError(LAZADA_PUSH_ERRORS, sku('4225'), lz, op)).toMatchObject({ code: 'semi_hosted_product', kind: 'platform', target: null });
    }
  });

  it.each(['4104', '4118', 'BIZ_CHECK_PRICE_PRECISION_INVALID', 'BIZ_CHECK_PRICE_IS_ZERO'])('Lazada %s khi đẩy giá: giá sai, mở ô giá', (code) => {
    expect(translatePlatformError(LAZADA_PUSH_ERRORS, sku(code), lz, 'price')).toMatchObject({
      code: 'price_invalid',
      kind: 'data',
      target: { kind: 'variant_field', field: 'price' },
      platformCode: code,
    });
  });

  it.each([
    ['12052393', 'stock'],
    ['12052165', 'stock'],
    ['12052038', 'price'],
    ['12019045', 'price'],
  ] as const)('TikTok %s khi đẩy %s là khoá do khuyến mãi', (code, op) => {
    expect(translatePlatformError(TIKTOK_PUSH_ERRORS, sku(code), tt, op)).toMatchObject({ code: 'promotion_locked', kind: 'platform', platformCode: code, mapped: true });
  });

  it('TikTok 12052038 (khoá giá) không dịch nhầm lỗi đăng sản phẩm', () => {
    expect(translatePlatformError(TIKTOK_PUSH_ERRORS, sku('12052038'), tt, 'push').code).not.toBe('promotion_locked');
  });

  it('khoá tồn không khớp khi đẩy giá', () => {
    expect(translatePlatformError(TIKTOK_PUSH_ERRORS, sku('12052393'), tt, 'price').mapped).toBe(false);
  });
});
