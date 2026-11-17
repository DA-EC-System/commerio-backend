// Ba lớp nhãn của SKU (#204, Documents/21 §17.1, spec 204 mục 5.3): độ hoàn thiện (trường của catalog cộng ngưỡng tồn
// của inventory), trạng thái kinh doanh (cột của SKU), hiện diện trên sàn (channel). Mỗi nguồn một lần gọi cho cả lô SKU,
// nên trang danh sách có số câu truy vấn cố định. Gọi trong `withCompany`.
import { requireCompanyId } from '../../../../shared/db/client.ts';
import { type MissingField, type ParentFields, type Readiness, readinessOf } from '../domain/labels.ts';
import { productImageRows } from '../repository/product-images.ts';
import { findVariants, type VariantRow } from '../repository/variants.ts';
import { isUuid } from './errors.ts';
import { type CatalogContext, type ListingPresence, requirePort } from './usage.ts';

const NOT_LISTED: ListingPresence = { presence: 'not_listed', hasListingError: false, listingCount: 0 };

/** Nhãn của một SKU trên API (`ProductVariant`); trạng thái kinh doanh nằm sẵn ở SKU. */
export interface SkuLabels extends ListingPresence {
  readiness: Readiness;
  missing: MissingField[];
  /** Ngưỡng tồn của inventory; null là chưa đặt. */
  minQty: number | null;
}

/** Nhãn cho các SKU (có thể của nhiều sản phẩm); `parentOf` cho trường chung của cha (tên, danh mục, số ảnh). */
export async function skuLabels(
  ctx: CatalogContext,
  rows: readonly VariantRow[],
  parentOf: (productId: string) => ParentFields,
): Promise<Map<string, SkuLabels>> {
  const ids = rows.map((v) => v.id);
  // Tuần tự: hai cổng dùng chung một client của giao dịch.
  const minQty = await requirePort(ctx, 'minQtyOf')(ids);
  const presence = await requirePort(ctx, 'listingPresenceOf')(ids);
  return new Map(
    rows.map((v) => {
      const q = minQty.get(v.id) ?? null;
      return [v.id, { ...readinessOf(parentOf(v.productId), { ...v, minQty: q }), minQty: q, ...(presence.get(v.id) ?? NOT_LISTED) }];
    }),
  );
}

/**
 * Độ hoàn thiện theo SKU cho module khác (channel thay luật tạm `paused → sku_not_ready` khi đẩy listing).
 * `minQtyOf` là cổng của inventory (`product/index.ts` ghép sẵn thành `variantReadiness`). Id không thấy (RLS, không có,
 * sai dạng) thì không có trong Map.
 */
export async function variantReadinessOf(
  variantIds: readonly string[],
  minQtyOf: NonNullable<CatalogContext['minQtyOf']>,
): Promise<Map<string, { readiness: Readiness; missing: MissingField[] }>> {
  requireCompanyId('variantReadiness');
  const rows = await findVariants({ ids: variantIds.filter(isUuid) });
  if (!rows.length) return new Map();
  const withImage = new Set((await productImageRows([...new Set(rows.map((v) => v.productId))], 1)).map((i) => i.productId));
  const minQty = await minQtyOf(rows.map((v) => v.id));
  return new Map(
    rows.map((v) => [
      v.id,
      readinessOf(
        { name: v.productName, categoryId: v.categoryId, imageCount: withImage.has(v.productId) ? 1 : 0 },
        { ...v, minQty: minQty.get(v.id) ?? null },
      ),
    ]),
  );
}
