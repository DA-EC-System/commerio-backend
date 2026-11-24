// Khai báo ghép trục của adapter (#448 L3, Documents#214 mục 3): mã sales chuẩn và khả năng khai biến thể theo leaf.
import { describe, expect, it, vi } from 'vitest';
import type { PlatformAttribute } from '#src/modules/channel/channel/domain/product-spec.ts';
import { lazadaVariantCapabilities } from '#src/modules/channel/channel/service/marketplaces/lazada-categories.ts';
import { createLazadaAdapter } from '#src/modules/channel/channel/service/marketplaces/lazada.ts';
import { createTiktokAdapter } from '#src/modules/channel/channel/service/marketplaces/tiktok.ts';

const attr = (code: string, over: Partial<PlatformAttribute> = {}): PlatformAttribute => ({
  code,
  label: code,
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

describe('Lazada', () => {
  const config = { appKey: '1', appSecret: 's', redirectUrl: undefined, apiUrl: 'https://api.test/rest', authUrl: 'https://auth.test' };
  const adapter = createLazadaAdapter(config, vi.fn());

  it('mã chuẩn theo platform_kind đúng bảng Documents/21 §18.8.3; age, style không có mã', () => {
    expect(adapter.standardSalesAttributes).toEqual({
      color: ['color_family'],
      size: ['size', 'clothing_size', 'Toy_Size', 'basic_size'],
      shoe_size: ['size'],
      bra_size: ['size'],
      ring_size: ['ring_size'],
      storage: ['storage_capacity_new', 'Storage_Size'],
      version: ['Variation'],
      screen_size: ['display_size_tv', 'smartwear_size'],
      connector: ['cable_connection', 'wear_acc_connectivity'],
      length: ['cable_length', 'Length_(m)', 'curtain_length'],
      battery_capacity: ['powerbank_capacity'],
      voltage: ['input_voltage'],
      power: ['power_consumption'],
      volume: ['volume', 'capacity'],
      weight: ['pet_food_size', 'weight'],
      flavor: ['flavor', 'pets_flavor'],
      scent: ['scent', 'fragrance_family', 'Baby_scent'],
      pack: ['Units_(per_Bundle)', 'units_hb', 'units', 'diaper_pack_size', 'number_of_pieces'],
      diaper_size: ['size_diaper', 'size'],
      bed_size: ['bedding_size_2', 'mattress_size', 'size'],
      compatible_model: ['compatibility_by_model'],
    });
  });

  it('caps: maxAxes = số sale prop của leaf, không nhận tên tự đặt, salesRequired = sale prop bắt buộc; property không tính', () => {
    const leaf = [attr('color_family', { required: true }), attr('size'), attr('material', { kind: 'property', required: true })];
    expect(lazadaVariantCapabilities(leaf)).toEqual({ maxAxes: 2, customAxisName: false, salesRequired: ['color_family'], addVariant: true, maxValueLength: 20, maxAxisValues: 50 });
    expect(adapter.variantCapabilities!(leaf)).toEqual({ maxAxes: 2, customAxisName: false, salesRequired: ['color_family'], addVariant: true, maxValueLength: 20, maxAxisValues: 50 });
    expect(lazadaVariantCapabilities([])).toEqual({ maxAxes: 0, customAxisName: false, salesRequired: [], addVariant: true, maxValueLength: 20, maxAxisValues: 50 });
  });
});

describe('TikTok', () => {
  const adapter = createTiktokAdapter(
    { appKey: 'k', appSecret: 's', serviceId: undefined, apiUrl: 'https://api.test', authUrl: 'https://auth.test' },
    vi.fn(),
  );

  it('mã chuẩn đúng bảng Documents/21 §18.8.3 (kind không có id thì trục tự đặt) và caps cố định', () => {
    expect(adapter.standardSalesAttributes).toEqual({
      color: ['100000'],
      size: ['100007', '100001'],
      shoe_size: ['100007'],
      bra_size: ['100007'],
      age: ['100103'],
      ring_size: ['100070', '100007'],
      storage: ['100027', '100090'],
      volume: ['100089', '100042'],
      weight: ['100089'],
      flavor: ['100092', '100081'],
      scent: ['100009'],
      pack: ['100089'],
      diaper_size: ['100007'],
      bed_size: ['100001', '100007'],
    });
    expect(adapter.variantCapabilities!([])).toEqual({ maxAxes: 3, customAxisName: true, salesRequired: [], addVariant: true, maxValueLength: 50, maxAxisValues: null });
  });
});
