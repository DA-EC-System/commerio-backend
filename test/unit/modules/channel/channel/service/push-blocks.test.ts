import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import type { ListingVariant } from '#src/modules/channel/channel/service/product-port.ts';
import { blockerScope, feeBlock, groupBlockers, pushBlock, pushBlocks, type SpecCheck } from '#src/modules/channel/channel/service/push-block.ts';

// Readiness theo gian hàng (be#564, Documents/21 §18.10): mọi mục chặn, mỗi mục có scope và chỗ sửa.
const variant: ListingVariant = {
  id: 'v',
  productId: 'p',
  productName: 'Áo',
  sku: 'A-1',
  attributesLabel: '',
  productCode: 'SP-TEST',
  groupId: 'GROUP-TEST',
  attributes: [],
  archived: false,
  businessStatus: 'selling',
  description: null,
  weightG: 100,
  lengthMm: 100,
  widthMm: 100,
  heightMm: 100,
};
const spec = (extra: Partial<SpecCheck> = {}): SpecCheck => ({ externalCategoryId: 'L1', missing: [], permission: null, sizeChartRule: null, ...extra });
const price = new Decimal(1000);

describe('pushBlocks: trả mọi mục, thứ tự như pushBlock', () => {
  it('đủ dữ liệu: rỗng', () => {
    expect(pushBlocks(variant, price, spec(), true)).toEqual([]);
  });

  it('thiếu giá, chưa có category, thiếu cân nặng, thiếu ảnh: bốn mục theo thứ tự, mã đầu bằng pushBlock', () => {
    const items = pushBlocks({ ...variant, weightG: null }, null, undefined, false);
    expect(items.map((b) => b.code)).toEqual(['price_missing', 'category_unmapped', 'dimensions_missing', 'images_missing']);
    expect(pushBlock({ ...variant, weightG: null }, null, undefined, false)?.code).toBe('price_missing');
  });

  it('chỗ sửa: giá, category, cân nặng (thiếu cân nặng) hoặc kích thước, ảnh', () => {
    const items = pushBlocks({ ...variant, weightG: null }, null, undefined, false);
    expect(items.map((b) => b.target)).toEqual([
      { kind: 'variant_field', field: 'price' },
      { kind: 'category' },
      { kind: 'variant_field', field: 'weight' },
      { kind: 'product_field', field: 'images' },
    ]);
    expect(pushBlocks({ ...variant, heightMm: null }, price, spec(), true)[0]!.target).toEqual({ kind: 'variant_field', field: 'dimensions' });
  });

  it('spec thiếu hai attribute: hai mục spec_incomplete, mỗi mục một ô; pushBlock vẫn gộp nhãn vào một câu', () => {
    const missing = [
      { code: 'a', label: 'Chất liệu', reason: 'required' as const },
      { code: 'b', label: 'Kiểu dáng', reason: 'required_when' as const },
    ];
    const items = pushBlocks(variant, price, spec({ missing }), true);
    expect(items).toEqual([
      expect.objectContaining({ code: 'spec_incomplete', label: 'Chất liệu', target: { kind: 'spec_attribute', attributeCode: 'a' } }),
      expect.objectContaining({ code: 'spec_incomplete', label: 'Kiểu dáng', target: { kind: 'spec_attribute', attributeCode: 'b' } }),
    ]);
    expect(pushBlock(variant, price, spec({ missing }), true)).toEqual({ code: 'spec_incomplete', message: 'Chất liệu, Kiểu dáng' });
  });

  it('trục: chưa ánh xạ → spec_incomplete chỗ sửa axis; sale prop bắt buộc → axis_unmapped_required; vượt số → axis_limit chỗ sửa category', () => {
    const missing = [
      { code: 'attr-1', label: 'Màu', reason: 'axis_unmapped' as const },
      { code: 'color_family', label: 'Màu sắc', reason: 'sales_required' as const },
      { code: 'axes', label: 'Sản phẩm có 3 thuộc tính biến thể, category này nhận tối đa 2', reason: 'axis_limit' as const },
    ];
    expect(pushBlocks(variant, price, spec({ missing }), true).map((b) => [b.code, b.target])).toEqual([
      ['spec_incomplete', { kind: 'axis', attributeId: 'attr-1' }],
      ['axis_unmapped_required', { kind: 'axis' }],
      ['axis_limit', { kind: 'category' }],
    ]);
  });

  it('category trên sàn đổi hay bị bỏ: chỗ sửa là category', () => {
    const missing = [{ code: 'externalCategoryId', label: 'Category trên sàn đã đổi, chọn lại category', reason: 'category_changed' as const }];
    expect(pushBlocks(variant, price, spec({ missing }), true)[0]!.target).toEqual({ kind: 'category' });
  });

  it('không được bán category: category_not_permitted, chỗ sửa quyền của gian hàng', () => {
    expect(pushBlocks(variant, price, spec({ permission: 'invite_only' }), true)).toEqual([
      expect.objectContaining({ code: 'category_not_permitted', target: { kind: 'shop', field: 'category_permission' } }),
    ]);
  });

  it('SKU tạm ngừng: mã cụ thể trả trước sku_not_ready (21 §18.6.4)', () => {
    expect(pushBlocks({ ...variant, businessStatus: 'paused' }, null, spec(), true).map((b) => b.code)).toEqual(['price_missing', 'sku_not_ready']);
    expect(pushBlock({ ...variant, businessStatus: 'paused' }, price, spec(), true)?.code).toBe('sku_not_ready');
  });
});

describe('blockerScope (§18.10)', () => {
  it.each([
    ['sku_not_ready', 'common'],
    ['price_missing', 'common'],
    ['dimensions_missing', 'common'],
    ['images_missing', 'common'],
    ['fee_not_configured', 'shop'],
    ['below_floor', 'shop'],
    ['category_not_permitted', 'shop'],
    ['category_unmapped', 'platform'],
    ['spec_incomplete', 'platform'],
    ['axis_limit', 'platform'],
    ['variant_images_missing', 'platform'],
    ['size_chart_missing', 'platform'],
    ['platform_product_ambiguous', 'platform'],
    ['axis_shape', 'platform'],
    ['axis_unmapped', 'platform'],
    ['not_found', 'shop'],
    ['already_listed', 'shop'],
  ] as const)('%s → %s', (code, scope) => {
    expect(blockerScope(code)).toBe(scope);
  });
});

describe('feeBlock (21 §18.9 R5, điều kiện của be#559)', () => {
  const shop = { shopName: 'Shop A' };
  it('lần đăng đầu, đăng lại sau gỡ hoặc sau lỗi của SKU do app tạo, gian hàng chưa có phí: chặn', () => {
    for (const existing of [undefined, { status: 'delisted' as const }, { status: 'push_failed' as const, contentSource: 'app' as const, externalProductId: null, externalSkuId: null }]) {
      expect(feeBlock(shop, existing, false)).toMatchObject({ code: 'fee_not_configured', target: { kind: 'shop', field: 'fee_config' } });
    }
  });

  it('có phí, hoặc bật lại SKU người bán, hoặc listing đang bán: không chặn', () => {
    expect(feeBlock(shop, undefined, true)).toBeNull();
    expect(feeBlock(shop, { status: 'push_failed', contentSource: 'platform', externalProductId: 'P', externalSkuId: 'S' }, false)).toBeNull();
    expect(feeBlock(shop, { status: 'rejected' }, false)).toBeNull();
  });
});

describe('groupBlockers', () => {
  it('gom theo mã và chỗ sửa, giữ thứ tự gặp, gắn scope', () => {
    const price = { code: 'price_missing' as const, label: 'Chưa có giá chuẩn', target: { kind: 'variant_field' as const, field: 'price' as const } };
    const a = { code: 'spec_incomplete' as const, label: 'Chất liệu', target: { kind: 'spec_attribute' as const, attributeCode: 'a' } };
    const b = { ...a, label: 'Kiểu', target: { kind: 'spec_attribute' as const, attributeCode: 'b' } };
    expect(groupBlockers([{ variantId: 'v1', items: [price, a] }, { variantId: 'v2', items: [price, b] }])).toEqual([
      { ...price, scope: 'common', variantIds: ['v1', 'v2'] },
      { ...a, scope: 'platform', variantIds: ['v1'] },
      { ...b, scope: 'platform', variantIds: ['v2'] },
    ]);
  });
});

describe('byDisplayOrder', () => {
  it('xếp platform, common, shop; cùng scope giữ thứ tự gặp (push và readiness dùng chung)', async () => {
    const { byDisplayOrder, groupBlockers } = await import('#src/modules/channel/channel/service/push-block.ts');
    const items = [
      { code: 'fee_not_configured' as const, label: 'Phí', target: { kind: 'shop' as const, field: 'fee_config' as const } },
      { code: 'price_missing' as const, label: 'Giá', target: { kind: 'variant_field' as const, field: 'price' as const } },
      { code: 'category_unmapped' as const, label: 'Cat', target: { kind: 'category' as const } },
      { code: 'images_missing' as const, label: 'Ảnh', target: { kind: 'product_field' as const, field: 'images' as const } },
    ];
    expect(groupBlockers([{ variantId: 'v1', items }]).sort(byDisplayOrder).map((b) => b.code)).toEqual(['category_unmapped', 'price_missing', 'images_missing', 'fee_not_configured']);
  });
});
