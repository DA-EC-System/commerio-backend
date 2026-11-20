// Ba lớp nhãn của SKU (#204, Documents/21 §17.1, 25 §5.1, §5.2): độ hoàn thiện (tính), trạng thái kinh doanh (lưu),
// hiện diện trên sàn (tính từ listing, do channel cấp). Hàm thuần.
import type { BusinessStatus } from './business-status.ts';

/**
 * Phần còn thiếu theo thứ tự cố định; `name`, `image`, `variantImages` ở cha, còn lại ở SKU. `price` là giá
 * muốn bán (D7). `variantImages`: ảnh phân loại có một phần (#340).
 */
export const MISSING_FIELDS = ['name', 'image', 'variantImages', 'price', 'minQty', 'weight', 'dimensions'] as const;
export type MissingField = (typeof MISSING_FIELDS)[number];

/** Hiện diện trên sàn (D8, `25` §5.1): `live` > `error` > `pending` > `not_listed`. */
export const PRESENCES = ['live', 'error', 'pending', 'not_listed'] as const;
export type Presence = (typeof PRESENCES)[number];

/** Nhãn chính: trạng thái kinh doanh khác `selling`, không thì hiện diện trên sàn. */
export const MAIN_LABELS = ['archived', 'discontinued', 'paused', 'live', 'error', 'pending', 'not_listed'] as const;
export type MainLabel = (typeof MAIN_LABELS)[number];

export type Readiness = 'ready' | 'incomplete';

export interface ParentFields {
  name: string;
  imageCount: number;
  /**
   * Ảnh phân loại có một phần (#340, Documents/21 §17.1): có ảnh cho ít nhất một giá trị của thuộc tính gắn ảnh mà SKU
   * chưa lưu trữ đang dùng, và còn giá trị đang dùng khác chưa có ảnh. Chưa có ảnh nào thì không thiếu.
   */
  variantImagesPartial: boolean;
}

export interface SkuFields {
  /** Giá muốn bán, chuỗi `numeric`; null là chưa đặt. */
  targetNetPrice: string | null;
  minQty: number | null;
  weightG: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
}

/** Độ hoàn thiện của một SKU: cha thiếu trường chung thì SKU cũng thiếu phần đó (`25` §5.4). */
export function readinessOf(parent: ParentFields, sku: SkuFields): { readiness: Readiness; missing: MissingField[] } {
  const lacks: Record<MissingField, boolean> = {
    name: !parent.name.trim(),
    image: parent.imageCount < 1,
    variantImages: parent.variantImagesPartial,
    price: sku.targetNetPrice === null,
    minQty: sku.minQty === null,
    weight: sku.weightG === null,
    dimensions: sku.lengthMm === null || sku.widthMm === null || sku.heightMm === null,
  };
  const missing = MISSING_FIELDS.filter((f) => lacks[f]);
  return { readiness: missing.length ? 'incomplete' : 'ready', missing };
}

export function mainLabel(status: BusinessStatus, presence: Presence): MainLabel {
  return status === 'selling' ? presence : status;
}

export interface LabelledSku {
  businessStatus: BusinessStatus;
  presence: Presence;
  /** Có listing lỗi, kể cả khi đã `live` (nhãn phụ "Có lỗi", D8). */
  hasListingError: boolean;
  readiness: Readiness;
}

/**
 * Số đếm cho danh sách (Documents/21 §17.1): `labelCounts` đủ 7 khoá, tính mọi SKU; `variantCount`, `incompleteCount`,
 * `errorCount` chỉ tính SKU chưa lưu trữ. `errorCount` đếm SKU có listing lỗi, kể cả SKU đang `live` (lỗi đếm riêng).
 */
export function countLabels(skus: readonly LabelledSku[]) {
  const labelCounts = Object.fromEntries(MAIN_LABELS.map((l) => [l, 0])) as Record<MainLabel, number>;
  let variantCount = 0;
  let incompleteCount = 0;
  let errorCount = 0;
  for (const s of skus) {
    labelCounts[mainLabel(s.businessStatus, s.presence)]++;
    if (s.businessStatus === 'archived') continue;
    variantCount++;
    if (s.readiness === 'incomplete') incompleteCount++;
    if (s.hasListingError) errorCount++;
  }
  return { variantCount, variantTotal: skus.length, labelCounts, incompleteCount, errorCount };
}
