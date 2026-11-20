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

  it('mã chuẩn theo platform_kind', () => {
    expect(adapter.standardSalesAttributes).toEqual({ color: ['color_family'], size: ['size'], volume: ['volume'], flavor: ['flavor'] });
  });

  it('caps: maxAxes = số sale prop của leaf, không nhận tên tự đặt, salesRequired = sale prop bắt buộc; property không tính', () => {
    const leaf = [attr('color_family', { required: true }), attr('size'), attr('material', { kind: 'property', required: true })];
    expect(lazadaVariantCapabilities(leaf)).toEqual({ maxAxes: 2, customAxisName: false, salesRequired: ['color_family'], addVariant: true });
    expect(adapter.variantCapabilities!(leaf)).toEqual({ maxAxes: 2, customAxisName: false, salesRequired: ['color_family'], addVariant: true });
    expect(lazadaVariantCapabilities([])).toEqual({ maxAxes: 0, customAxisName: false, salesRequired: [], addVariant: true });
  });
});

describe('TikTok', () => {
  const adapter = createTiktokAdapter(
    { appKey: 'k', appSecret: 's', serviceId: undefined, apiUrl: 'https://api.test', authUrl: 'https://auth.test' },
    vi.fn(),
  );

  it('mã chuẩn và caps cố định', () => {
    expect(adapter.standardSalesAttributes).toEqual({ color: ['100000'], size: ['100007', '100001'], volume: ['100089'], flavor: ['100092'] });
    expect(adapter.variantCapabilities!([])).toEqual({ maxAxes: 3, customAxisName: true, salesRequired: [], addVariant: true });
  });
});
