// Dữ liệu SKU và số khả dụng từ module `product`, đi qua cổng §11.1 (#104 Q2). Gọi trong `withCompany`.
// Trường cân nặng, kích thước, mô tả do #110 thêm vào `getVariants`; chưa có thì đọc ra null: đẩy sản phẩm báo
// `dimensions_missing`. Khả dụng là cổng `availableOf` của inventory (Documents/21 mục 11.1).
import type { Decimal } from 'decimal.js';
import {
  availableOf,
  countedOf,
  getVariants,
  productImageUrls,
  productSizeChartUrls,
  standardPricesOf,
  type VariantSummary,
} from '../../../product/index.ts';
import type { ModuleContext } from '../../../../shared/module.ts';

export interface ListingVariant {
  id: string;
  productId: string;
  productName: string;
  /** Mã cha của sản phẩm (#400 A5). */
  productCode: string;
  sku: string;
  categoryId: string;
  /** "Đen / M"; rỗng khi không có thuộc tính. */
  attributesLabel: string;
  /** Giá trị thuộc tính theo `position` (#400: ánh xạ trục biến thể sang sales attribute của sàn). */
  attributes: { attributeId: string; attributeName: string; valueId: string; value: string }[];
  archived: boolean;
  /**
   * Trạng thái kinh doanh của SKU. Tới khi #204 trả `readiness`, `paused` là SKU chưa sẵn sàng đẩy (`sku_not_ready`, #219
   * A2; Documents/25 §6.3).
   */
  businessStatus: 'selling' | 'paused' | 'discontinued' | 'archived';
  description: string | null;
  weightG: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  /** Xuất xứ (ISO alpha-2), thương hiệu của sản phẩm cha ở catalog (#340); adapter đổi sang giá trị sàn (#400 A1). */
  originCountry?: string | null;
  brand?: string | null;
}

export interface ProductPort {
  /** Bỏ trống `ids` = mọi biến thể của công ty; `opts.productIds` lọc theo sản phẩm, `[]` là rỗng (#400 A13). */
  variants(ids?: readonly string[], opts?: { productIds?: readonly string[] }): Promise<ListingVariant[]>;
  standardPrices(ids: readonly string[]): Promise<Map<string, Decimal | null>>;
  /** Có mọi biến thể của công ty (chưa có tồn thì 0); id lạ không có trong Map thì không đẩy tồn (#222). */
  availableOf(ids: readonly string[]): Promise<Map<string, number>>;
  /** SKU kho đã có số (#460); thiếu (bản giả của test) thì coi mọi SKU đã có số. */
  countedOf?(ids: readonly string[]): Promise<Set<string>>;
  /**
   * Link ảnh catalog theo sản phẩm (#303), tối đa `max` ảnh đầu theo thứ tự; sản phẩm chưa có ảnh (hoặc máy chủ chưa
   * cấu hình link ảnh) không có trong Map.
   */
  productImageUrls(productIds: readonly string[], max: number): Promise<Map<string, string[]>>;
  /** Link ảnh bảng kích cỡ theo sản phẩm (#347); sản phẩm chưa có ảnh không có trong Map. */
  productSizeChartUrls?(productIds: readonly string[]): Promise<Map<string, string>>;
}

// Trường #110 sẽ thêm; đọc tuỳ chọn để code không đổi khi Khang merge.
type Extended = VariantSummary &
  Partial<Record<'description', string | null> & Record<'weightG' | 'lengthMm' | 'widthMm' | 'heightMm', number | null>>;

function toListingVariant(v: Extended): ListingVariant {
  return {
    id: v.id,
    productId: v.productId,
    productName: v.productName,
    productCode: v.productCode,
    sku: v.sku,
    categoryId: v.categoryId,
    attributesLabel: v.attributes.map((a) => a.value).join(' / '),
    attributes: v.attributes.map(({ attributeId, attributeName, valueId, value }) => ({ attributeId, attributeName, valueId, value })),
    archived: v.archived,
    businessStatus: v.businessStatus,
    description: v.description ?? null,
    weightG: v.weightG ?? null,
    lengthMm: v.lengthMm ?? null,
    widthMm: v.widthMm ?? null,
    heightMm: v.heightMm ?? null,
    originCountry: v.originCountry,
    brand: v.brand,
  };
}

let override: ProductPort | null = null;

export function productPort(ctx: ModuleContext): ProductPort {
  return (
    override ?? {
      variants: async (ids, opts) => (await getVariants(ids, opts)).map(toListingVariant),
      standardPrices: (ids) => standardPricesOf(ctx, ids),
      availableOf,
      countedOf,
      productImageUrls,
      productSizeChartUrls,
    }
  );
}

/** Test thay cổng bằng bản giả, như `registerAdapter`. */
export function setProductPort(port: ProductPort | null): void {
  override = port;
}
