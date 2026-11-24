import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import type { ListingRow } from '#src/modules/channel/channel/repository/listings.ts';
import type { ListingVariant } from '#src/modules/channel/channel/service/product-port.ts';
import { checkVariant, type PushContext } from '#src/modules/channel/channel/service/push-check.ts';

// Hàm kiểm chung của push, push-preview, readiness (be#564, Documents/21 §18.10, §18.6.4).
const variant: ListingVariant = {
  id: 'v1',
  productId: 'p',
  productName: 'Áo',
  sku: 'A-1',
  attributesLabel: '',
  productCode: 'SP',
  groupId: 'G',
  attributes: [],
  archived: false,
  businessStatus: 'selling',
  description: null,
  weightG: 100,
  lengthMm: 100,
  widthMm: 100,
  heightMm: 100,
};

const ctx = (over: Partial<PushContext> = {}): PushContext => ({
  shop: { id: 's', shopName: 'Shop A' },
  variants: new Map([['v1', variant]]),
  siblings: [variant],
  standard: new Map([['v1', new Decimal(1000)]]),
  specs: new Map([['p', { externalCategoryId: 'L', missing: [], permission: null, sizeChartRule: null, row: { axisMap: {} }, attributes: null } as never]]),
  gaps: new Map(),
  current: new Map(),
  selling: new Map([['v1', 1000]]),
  images: new Map([['p', ['https://x/1.jpg']]]),
  sizeCharts: new Map(),
  feeConfigured: true,
  manual: new Map(),
  manualChecks: new Map(),
  calcs: new Map(),
  newByProduct: new Map([['p', [variant]]]),
  ...over,
});

const listing = (over: Partial<ListingRow>) => ({ id: 'l1', status: 'push_failed', manualPrice: null, priceCalcId: null, contentSource: 'app', ...over }) as ListingRow;

describe('checkVariant', () => {
  it('đủ dữ liệu: không có mục chặn, giá là giá đang bán', () => {
    expect(checkVariant(ctx(), 'v1')).toEqual({ items: [], price: { value: '1000' }, existing: undefined });
  });

  it('mã trạng thái listing chỉ một mục, chỗ sửa là listing; biến thể không còn: listingId null', () => {
    expect(checkVariant(ctx({ variants: new Map() }), 'v1').items).toEqual([
      { code: 'not_found', label: 'Biến thể không còn bán', target: { kind: 'listing', listingId: null } },
    ]);
    const live = checkVariant(ctx({ current: new Map([['v1', listing({ status: 'live' })]]) }), 'v1');
    expect(live.items.map((b) => [b.code, b.target])).toEqual([['already_listed', { kind: 'listing', listingId: 'l1' }]]);
    expect(checkVariant(ctx({ current: new Map([['v1', listing({ status: 'pushing' })]]) }), 'v1').items[0]!.code).toBe('push_in_progress');
    expect(checkVariant(ctx({ current: new Map([['v1', listing({ pendingExternalSkuId: 'X' })]]) }), 'v1').items[0]!.code).toBe('mapping_pending');
  });

  it('chưa có phí: fee_not_configured đứng trước mục dữ liệu', () => {
    const r = checkVariant(ctx({ feeConfigured: false, standard: new Map([['v1', null]]), selling: new Map([['v1', null]]) }), 'v1');
    expect(r.items.map((b) => b.code)).toEqual(['fee_not_configured', 'price_missing']);
    expect(r.price.value).toBeNull();
  });

  it('giá gõ thắng giá bộ lọc; giá bộ lọc trả kèm calc để hiện làm tròn', () => {
    const calc = { rawPrice: '1234.5', roundedPrice: '1300', belowFloor: false } as never;
    expect(checkVariant(ctx({ calcs: new Map([['v1', calc]]) }), 'v1').price).toEqual({ value: '1300', calc: { rawPrice: '1234.5', roundedPrice: '1300' } });
    expect(checkVariant(ctx({ calcs: new Map([['v1', calc]]), manual: new Map([['v1', '2000']]) }), 'v1').price).toEqual({ value: '2000' });
  });

  it('dưới giá thấp nhất: below_floor cuối, chỗ sửa ô giá', () => {
    const calc = { rawPrice: '900', roundedPrice: '900', belowFloor: true } as never;
    expect(checkVariant(ctx({ calcs: new Map([['v1', calc]]) }), 'v1').items).toEqual([
      expect.objectContaining({ code: 'below_floor', target: { kind: 'variant_field', field: 'price' } }),
    ]);
    const manual = checkVariant(ctx({ manual: new Map([['v1', '10']]), manualChecks: new Map([['v1', { ok: true, belowFloor: true } as never]]) }), 'v1');
    expect(manual.items.map((b) => b.code)).toEqual(['below_floor']);
  });

  it('chưa có category: category_unmapped, không kiểm gom biến thể', () => {
    expect(checkVariant(ctx({ specs: new Map() }), 'v1').items.map((b) => b.code)).toEqual(['category_unmapped']);
  });

  it('SKU tạm ngừng: mục cụ thể trước sku_not_ready', () => {
    const paused = { ...variant, businessStatus: 'paused' as const, weightG: null };
    expect(checkVariant(ctx({ variants: new Map([['v1', paused]]) }), 'v1').items.map((b) => b.code)).toEqual(['dimensions_missing', 'sku_not_ready']);
  });
});
