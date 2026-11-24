// Điều kiện dữ liệu để đẩy một biến thể lên sàn (#219, #400, Documents/21 §18.5, §18.6.4); dùng chung cho request `push`
// (`listings.ts`) và việc nền (`listing-push.ts`), tách riêng để hai file không import vòng.
import type { Decimal } from 'decimal.js';
import type { BlockerCode, BlockItem } from '../domain/blocker.ts';
import type { CategoryPermission, MissingItem, PlatformAttribute } from '../domain/product-spec.ts';
import { type GroupVariant, groupVariants } from '../domain/variant-group.ts';
import type { SizeChartRule } from '../repository/schema.ts';
import type { ListingVariant } from './product-port.ts';

/** Lý do một dòng không đẩy được, theo bảng mã 21 §18.5 và `sku_not_ready` (§18.6.4). */
export interface PushBlock {
  code:
    | 'sku_not_ready'
    | 'price_missing'
    | 'category_unmapped'
    | 'spec_incomplete'
    | 'category_not_permitted'
    | 'dimensions_missing'
    | 'images_missing'
    | 'variant_images_missing'
    | 'size_chart_missing';
  message: string;
}

/**
 * Tình trạng spec sàn của sản phẩm với một gian hàng (#400): `missing` theo attribute đã có trong bảng (leaf chưa lấy thì
 * chỉ xét category, trục: request cho qua, việc nền lấy rồi kiểm lại, A16); `permission` quyền đã ghi của gian hàng (TikTok,
 * chưa có dòng thì null, không chặn, A17); `sizeChartRule` của category (`platform_categories.size_chart_rule`).
 */
export interface SpecCheck {
  externalCategoryId: string;
  missing: readonly MissingItem[];
  permission: CategoryPermission | null;
  sizeChartRule: SizeChartRule | null;
}

/** Vị từ spec dùng chung request và việc nền (L025): chưa có spec, còn thiếu, không được bán category. */
export function specBlock(spec: SpecCheck | undefined): PushBlock | null {
  if (!spec) return { code: 'category_unmapped', message: 'Chưa chọn category của sàn cho sản phẩm' };
  if (spec.missing.length) return { code: 'spec_incomplete', message: spec.missing.map((m) => m.label).join(', ') };
  if (spec.permission && spec.permission !== 'available') {
    return { code: 'category_not_permitted', message: 'Gian hàng chưa được bán category này. Xin quyền trên Seller Center hoặc đổi category' };
  }
  return null;
}

/**
 * Lượt đẩy chỉ bật lại SKU người bán đã có trên sàn, không gửi nội dung, ảnh (#399 Ca 1): listing `contentSource = 'platform'`
 * có mã sàn, không phải `take-over-content`. Bản gỡ của listing ghép (`delisted`) cũng vậy: đẩy lại chép mã sàn và chủ nội dung.
 */
export function keepsPlatformContent(
  row: { contentSource: 'app' | 'platform'; externalProductId: string | null; externalSkuId: string | null } | undefined,
  takeOver = false,
): boolean {
  return Boolean(row && row.contentSource === 'platform' && !takeOver && row.externalProductId && row.externalSkuId);
}

/**
 * Spec đem kiểm khi đẩy, dùng chung request (`listings.ts`) và việc nền (`listing-push.ts`) để hai bên không lệch (review BE2
 * P1-1, Thành chốt 19/11/2026): đẩy lại SKU người bán chỉ bật lại trên sàn nên không xét spec (`category_unmapped`,
 * `spec_incomplete`, `category_not_permitted`, luật bảng kích cỡ); đẩy mới, đẩy lại SKU do app tạo giữ spec như có.
 */
export function pushSpec(keepContent: boolean, spec: SpecCheck | undefined): SpecCheck | undefined {
  if (!keepContent) return spec;
  return { externalCategoryId: spec?.externalCategoryId ?? '', missing: [], permission: null, sizeChartRule: null };
}

/** Thuộc tính gắn ảnh còn giá trị chưa có ảnh (#295). */
export interface VariantImageGap {
  attributeName: string;
  values: string[];
}

/**
 * Ảnh theo giá trị có một phần (Documents/21 §17 ảnh phân loại, §18.5 `variant_images_missing`), tính trên mọi SKU của một
 * sản phẩm cha: thuộc tính gắn ảnh là thuộc tính có giá trị trùng `image.attributeValueId` của SKU; có ít nhất một giá trị
 * có ảnh mà còn giá trị đang được SKU chưa lưu trữ dùng chưa có ảnh. Chưa có ảnh phân loại nào thì null. Hàm thuần.
 */
export function variantImageGap(variants: readonly ListingVariant[]): VariantImageGap | null {
  const live = variants.filter((v) => !v.archived);
  const withImage = new Set(live.flatMap((v) => (v.image ? [v.image.attributeValueId] : [])));
  if (!withImage.size) return null;
  const attr = live.flatMap((v) => v.attributes).find((a) => withImage.has(a.valueId));
  if (!attr) return null;
  const missing: string[] = [];
  for (const v of live) {
    const a = v.attributes.find((x) => x.attributeId === attr.attributeId);
    if (a && !withImage.has(a.valueId) && !missing.includes(a.value)) missing.push(a.value);
  }
  return missing.length ? { attributeName: attr.attributeName, values: missing } : null;
}

/** Khoảng trống ảnh theo giá trị của mỗi sản phẩm, chỉ khi sàn đòi đủ ảnh (`requiresAllVariantImages` của adapter). */
export function variantImageGaps(adapter: { requiresAllVariantImages?: boolean }, variants: readonly ListingVariant[]): Map<string, VariantImageGap> {
  const out = new Map<string, VariantImageGap>();
  if (!adapter.requiresAllVariantImages) return out;
  const byProduct = new Map<string, ListingVariant[]>();
  for (const v of variants) byProduct.set(v.productId, [...(byProduct.get(v.productId) ?? []), v]);
  for (const [productId, vs] of byProduct) {
    const gap = variantImageGap(vs);
    if (gap) out.set(productId, gap);
  }
  return out;
}

export const variantImagesMissing = (gap: VariantImageGap): PushBlock => ({
  code: 'variant_images_missing',
  message: `Sàn bắt buộc ảnh cho mọi giá trị của ${gap.attributeName}: thêm ảnh cho ${gap.values.join(', ')} rồi đăng lại`,
});

export { blockerScope, byDisplayOrder, groupBlockers, type Blocker, type BlockerCode, type BlockerScope, type BlockerTarget, type BlockItem } from '../domain/blocker.ts';

/** Mục chặn từ một dòng `missing` của spec: mỗi attribute, trục một mục (21 §18.10). */
function specItem(m: MissingItem): BlockItem {
  switch (m.reason) {
    case 'category_changed':
    case 'category_removed':
      return { code: 'spec_incomplete', label: m.label, target: { kind: 'category' } };
    case 'axis_limit':
      return { code: 'axis_limit', label: m.label, target: { kind: 'category' } };
    case 'sales_required':
      return { code: 'axis_unmapped_required', label: `Chưa có thuộc tính biến thể nào ánh xạ tới ${m.label} (bắt buộc)`, target: { kind: 'axis' } };
    case 'axis_unmapped':
    case 'axis_shape':
      return { code: 'spec_incomplete', label: m.label, target: { kind: 'axis', attributeId: m.code } };
    default:
      return { code: 'spec_incomplete', label: m.label, target: { kind: 'spec_attribute', attributeCode: m.code } };
  }
}

/**
 * Mọi mục chặn đẩy của một biến thể, theo thứ tự cố định (thứ tự trước #400, chèn spec ngay sau `category_unmapped`, A14; `sku_not_ready` cuối, 21 §18.6.4).
 * Dùng chung cho request, việc nền và readiness (be#564): `pushBlock` là mục đầu.
 * `hasImages`: listing đã có ảnh trên sàn, hoặc sản phẩm có ảnh trong catalog (#303). `hasSizeChart`: sản phẩm có ảnh bảng
 * kích cỡ trong catalog (#347); category sàn `required` mà chưa có thì chặn `size_chart_missing`.
 */
export function pushBlocks(
  v: ListingVariant,
  price: Decimal | null,
  spec: SpecCheck | undefined,
  hasImages: boolean,
  hasSizeChart = false,
  /** Sàn đòi đủ ảnh theo giá trị mà sản phẩm còn thiếu (`variantImageGaps`); bỏ trống khi không gửi nội dung (bật lại SKU). */
  imageGap: VariantImageGap | null = null,
): BlockItem[] {
  const out: BlockItem[] = [];
  if (price === null) out.push({ code: 'price_missing', label: 'Chưa có giá chuẩn', target: { kind: 'variant_field', field: 'price' } });
  if (!spec) {
    out.push({ code: 'category_unmapped', label: 'Chưa chọn category của sàn cho sản phẩm', target: { kind: 'category' } });
  } else {
    out.push(...spec.missing.map(specItem));
    if (spec.permission && spec.permission !== 'available') {
      out.push({
        code: 'category_not_permitted',
        label: 'Gian hàng chưa được bán category này. Xin quyền trên Seller Center hoặc đổi category',
        target: { kind: 'shop', field: 'category_permission' },
      });
    }
  }
  if (!v.weightG || !v.lengthMm || !v.widthMm || !v.heightMm) {
    out.push({
      code: 'dimensions_missing',
      label: 'Thiếu cân nặng hoặc kích thước gói của SKU',
      target: { kind: 'variant_field', field: v.weightG ? 'dimensions' : 'weight' },
    });
  }
  if (!hasImages) out.push({ code: 'images_missing', label: 'Sàn bắt buộc ảnh: thêm ảnh cho sản phẩm', target: { kind: 'product_field', field: 'images' } });
  if (imageGap) {
    out.push({ code: 'variant_images_missing', label: variantImagesMissing(imageGap).message, target: { kind: 'product_field', field: 'variantImages' } });
  }
  if (spec?.sizeChartRule === 'required' && !hasSizeChart) {
    out.push({
      code: 'size_chart_missing',
      label: 'Danh mục này bắt buộc ảnh bảng kích cỡ: thêm ảnh bảng kích cỡ cho sản phẩm',
      target: { kind: 'product_field', field: 'sizeChart' },
    });
  }
  // Mã cụ thể trả trước `sku_not_ready` (21 §18.6.4). Tạm dùng trạng thái kinh doanh tới khi #204 trả `readiness` của SKU
  // (#219 A2, Documents/25 §6.3).
  if (v.businessStatus === 'paused') {
    out.push({ code: 'sku_not_ready', label: 'SKU đang tạm ngừng kinh doanh, chưa đẩy được', target: { kind: 'variant_field', field: 'price' } });
  }
  return out;
}

const SPEC_CODES: ReadonlySet<BlockerCode> = new Set(['spec_incomplete', 'axis_limit', 'axis_unmapped_required']);

/** Mục chặn đầu dạng mã + câu như trước #564; mục spec gộp nhãn mọi mục spec thành một câu. */
export function firstBlock(items: readonly BlockItem[]): { code: BlockerCode; message: string } | null {
  const first = items[0];
  if (!first) return null;
  if (!SPEC_CODES.has(first.code)) return { code: first.code, message: first.label };
  return { code: first.code, message: items.filter((b) => SPEC_CODES.has(b.code)).map((b) => b.label).join(', ') };
}

/** Mục chặn đầu của `pushBlocks` (việc nền, `update-content`, gom lại). */
export function pushBlock(...args: Parameters<typeof pushBlocks>): (Omit<PushBlock, 'code'> & { code: BlockerCode }) | null {
  return firstBlock(pushBlocks(...args));
}

/**
 * Chặn đăng khi gian hàng chưa có cấu hình phí đang áp dụng (21 §18.9 R5, be#559): lần đăng đầu, đăng lại sau gỡ hay sau lỗi
 * (không tính được giá thấp nhất), kể cả giá gõ tay. Bật lại SKU người bán (`content_source = platform`) là liên kết sẵn có,
 * không chặn.
 */
export function feeBlock(
  shop: { shopName: string },
  existing: ({ status: string } & Partial<Parameters<typeof keepsPlatformContent>[0] & object>) | undefined,
  feeConfigured: boolean,
): BlockItem | null {
  if (feeConfigured) return null;
  const firstListing =
    !existing ||
    existing.status === 'delisted' ||
    (existing.status === 'push_failed' &&
      !keepsPlatformContent({ contentSource: existing.contentSource ?? 'app', externalProductId: existing.externalProductId ?? null, externalSkuId: existing.externalSkuId ?? null }));
  if (!firstListing) return null;
  return {
    code: 'fee_not_configured',
    label: `Gian hàng ${shop.shopName} chưa có cấu hình phí. Soạn cấu hình phí và chờ CEO duyệt rồi đăng`,
    target: { kind: 'shop', field: 'fee_config' },
  };
}

/**
 * Mục chặn của phần gom biến thể (be#566, Documents/21 §18.11): `groupVariants` trên các SKU mới của một cha sẽ đi chung
 * một sản phẩm sàn, cùng hàm với việc nền (`product-push.ts`). Chỉ xét khi spec đã đủ: spec còn thiếu (kể cả trục chưa ánh
 * xạ) hay chưa có spec thì `pushBlocks` đã báo, không lặp mục. Hàm thuần.
 */
export function groupBlock(
  variants: readonly GroupVariant[],
  spec: (Pick<SpecCheck, 'missing'> & { row: { axisMap: Readonly<Record<string, string>> }; attributes: readonly PlatformAttribute[] | null }) | undefined,
): BlockItem | null {
  if (!spec || spec.missing.length || !variants.length) return null;
  const group = groupVariants(variants, spec.row.axisMap, spec.attributes);
  if (group.ok) return null;
  if (group.code === 'axis_unmapped') {
    const attributeId = variants[0]!.attributes.find((a) => !spec.row.axisMap[a.attributeId])?.attributeId;
    return { code: 'axis_unmapped', label: group.message, target: { kind: 'axis', ...(attributeId && { attributeId }) } };
  }
  return { code: 'axis_shape', label: group.message, target: { kind: 'axis' } };
}

/** Tên, mô tả đưa lên sàn của một biến thể, chung cho đẩy mới và sửa nội dung (#219, #293). */
export const listingText = (v: Pick<ListingVariant, 'productName' | 'attributesLabel' | 'description'>) => ({
  name: v.attributesLabel ? `${v.productName} - ${v.attributesLabel}` : v.productName,
  description: v.description ?? v.productName,
});
