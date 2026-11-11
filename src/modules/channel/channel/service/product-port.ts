// Dữ liệu SKU và số khả dụng từ module `product`, đi qua cổng §11.1 (#104 Q2). Gọi trong `withCompany`.
// Trường cân nặng, kích thước, mô tả do #110 thêm vào `getVariants`; chưa có thì đọc ra null: đẩy sản phẩm báo
// `dimensions_missing`. Khả dụng là cổng `availableOf` của inventory (Documents/21 mục 11.1).
import type { Decimal } from 'decimal.js';
import { availableOf, getVariants, standardPricesOf, type VariantSummary } from '../../../product/index.ts';
import type { ModuleContext } from '../../../../shared/module.ts';

export interface ListingVariant {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  categoryId: string;
  /** "Đen / M"; rỗng khi không có thuộc tính. */
  attributesLabel: string;
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
}

export interface ProductPort {
  /** Bỏ trống `ids` = mọi biến thể của công ty. */
  variants(ids?: readonly string[]): Promise<ListingVariant[]>;
  standardPrices(ids: readonly string[]): Promise<Map<string, Decimal | null>>;
  /** Có mọi biến thể của công ty (chưa có tồn thì 0); id lạ không có trong Map thì không đẩy tồn (#222). */
  availableOf(ids: readonly string[]): Promise<Map<string, number>>;
}

// Trường #110 sẽ thêm; đọc tuỳ chọn để code không đổi khi Khang merge.
type Extended = VariantSummary &
  Partial<Record<'description', string | null> & Record<'weightG' | 'lengthMm' | 'widthMm' | 'heightMm', number | null>>;

function toListingVariant(v: Extended): ListingVariant {
  return {
    id: v.id,
    productId: v.productId,
    productName: v.productName,
    sku: v.sku,
    categoryId: v.categoryId,
    attributesLabel: v.attributes.map((a) => a.value).join(' / '),
    archived: v.archived,
    businessStatus: v.businessStatus,
    description: v.description ?? null,
    weightG: v.weightG ?? null,
    lengthMm: v.lengthMm ?? null,
    widthMm: v.widthMm ?? null,
    heightMm: v.heightMm ?? null,
  };
}

let override: ProductPort | null = null;

export function productPort(ctx: ModuleContext): ProductPort {
  return (
    override ?? {
      variants: async (ids) => (await getVariants(ids)).map(toListingVariant),
      standardPrices: (ids) => standardPricesOf(ctx, ids),
      availableOf,
    }
  );
}

/** Test thay cổng bằng bản giả, như `registerAdapter`. */
export function setProductPort(port: ProductPort | null): void {
  override = port;
}
