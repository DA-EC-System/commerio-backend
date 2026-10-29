// Dữ liệu SKU và số khả dụng từ module `product`, đi qua cổng §11.1 (#104 Q2). Gọi trong `withCompany`.
// Trường cân nặng, kích thước, mô tả do #110 thêm vào `getVariants`; `availableOf` do #111 export. Chưa có thì đọc
// ra null / không có số: đẩy sản phẩm báo `dimensions_missing`, tồn đẩy lên là 0.
import type { Decimal } from 'decimal.js';
import { getVariants, standardPricesOf, type VariantSummary } from '../../../product/index.ts';
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
  /** Biến thể không có trong Map thì coi khả dụng là 0. */
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
      // #111 export `availableOf` thì gọi ở đây.
      availableOf: async () => new Map(),
    }
  );
}

/** Test thay cổng bằng bản giả, như `registerAdapter`. */
export function setProductPort(port: ProductPort | null): void {
  override = port;
}
