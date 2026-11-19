// Điều kiện dữ liệu để đẩy một biến thể lên sàn (#219, #400, Documents/21 §18.5, §18.6.4); dùng chung cho request `push`
// (`listings.ts`) và việc nền (`listing-push.ts`), tách riêng để hai file không import vòng.
import type { Decimal } from 'decimal.js';
import type { CategoryPermission, MissingItem } from '../domain/product-spec.ts';
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

/**
 * Dữ liệu đủ để đẩy chưa; dùng chung cho request (`listings.ts`) và việc nền (dữ liệu có thể đổi giữa hai lúc). Thứ tự giữ như
 * trước #400, chèn `spec_incomplete`, `category_not_permitted` ngay sau `category_unmapped` (A14).
 * `hasImages`: listing đã có ảnh trên sàn, hoặc sản phẩm có ảnh trong catalog (#303). `hasSizeChart`: sản phẩm có ảnh bảng
 * kích cỡ trong catalog (#347); category sàn `required` mà chưa có thì chặn `size_chart_missing`.
 */
export function pushBlock(
  v: ListingVariant,
  price: Decimal | null,
  spec: SpecCheck | undefined,
  hasImages: boolean,
  hasSizeChart = false,
): PushBlock | null {
  // Tạm dùng trạng thái kinh doanh tới khi #204 trả `readiness` của SKU (#219 A2, Documents/25 §6.3).
  if (v.businessStatus === 'paused') return { code: 'sku_not_ready', message: 'SKU đang tạm ngừng kinh doanh, chưa đẩy được' };
  if (price === null) return { code: 'price_missing', message: 'Chưa có giá chuẩn' };
  const bySpec = specBlock(spec);
  if (bySpec) return bySpec;
  if (!v.weightG || !v.lengthMm || !v.widthMm || !v.heightMm) {
    return { code: 'dimensions_missing', message: 'Thiếu cân nặng hoặc kích thước gói của SKU' };
  }
  if (!hasImages) return { code: 'images_missing', message: 'Sàn bắt buộc ảnh: thêm ảnh cho sản phẩm' };
  if (spec!.sizeChartRule === 'required' && !hasSizeChart) {
    return { code: 'size_chart_missing', message: 'Danh mục này bắt buộc ảnh bảng kích cỡ: thêm ảnh bảng kích cỡ cho sản phẩm' };
  }
  return null;
}

/** Tên, mô tả đưa lên sàn của một biến thể, chung cho đẩy mới và sửa nội dung (#219, #293). */
export const listingText = (v: Pick<ListingVariant, 'productName' | 'attributesLabel' | 'description'>) => ({
  name: v.attributesLabel ? `${v.productName} - ${v.attributesLabel}` : v.productName,
  description: v.description ?? v.productName,
});
