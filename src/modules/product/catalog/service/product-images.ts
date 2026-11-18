// Ảnh sản phẩm (#303; Documents/21 §5.2, §5.4 P8, P10). Tệp và link ảnh ở module `files` (bucket công khai).
import { publicFileUrls } from '../../../core/index.ts';
import { productImageRows } from '../repository/product-images.ts';
import { sizeChartRows } from '../repository/products.ts';
import { variantImageRows } from '../repository/variant-images.ts';

/** Tối đa 9 ảnh mỗi sản phẩm (P8). */
export const MAX_PRODUCT_IMAGES = 9;

export interface ProductImage {
  id: string;
  fileId: string;
  /** Link cố định của ảnh; chuỗi rỗng khi máy chủ chưa cấu hình `S3_PUBLIC_URL`. */
  url: string;
  /** 0 là ảnh đại diện. */
  position: number;
}

/**
 * Link ảnh của các sản phẩm cho module khác (channel: ảnh đại diện của listing, ảnh đẩy lên sàn), tối đa `max` ảnh đầu
 * theo `position`. Chỉ có khoá cho sản phẩm có ít nhất một link khác rỗng (thiếu `S3_PUBLIC_URL` thì không có sản
 * phẩm nào). Gọi trong `withCompany` của bên gọi.
 */
export async function productImageUrls(productIds: readonly string[], max: number): Promise<Map<string, string[]>> {
  const rows = await productImageRows(productIds, max);
  const urls = await publicFileUrls(rows.map((r) => r.fileId));
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const url = urls.get(r.fileId);
    if (!url) continue;
    out.set(r.productId, [...(out.get(r.productId) ?? []), url]);
  }
  return out;
}

/** Ảnh của một sản phẩm theo `position`. Gọi trong `withCompany`. */
export async function imagesOf(productId: string): Promise<ProductImage[]> {
  const rows = await productImageRows([productId]);
  const urls = await publicFileUrls(rows.map((r) => r.fileId));
  return rows.map((r) => ({ id: r.id, fileId: r.fileId, url: urls.get(r.fileId) ?? '', position: r.position }));
}

/** Ảnh bảng kích cỡ của sản phẩm (#347). */
export interface SizeChart {
  fileId: string;
  /** Link cố định; chuỗi rỗng khi máy chủ chưa cấu hình `S3_PUBLIC_URL`. */
  url: string;
}

export async function sizeChartOf(fileId: string | null): Promise<SizeChart | null> {
  if (!fileId) return null;
  return { fileId, url: (await publicFileUrls([fileId])).get(fileId) ?? '' };
}

/**
 * Link ảnh bảng kích cỡ cho module khác (channel đẩy lên sàn, #347). Chỉ có khoá cho sản phẩm có ảnh và có link khác
 * rỗng. Gọi trong `withCompany` của bên gọi.
 */
export async function productSizeChartUrls(productIds: readonly string[]): Promise<Map<string, string>> {
  const rows = await sizeChartRows(productIds);
  const urls = await publicFileUrls(rows.map((r) => r.fileId));
  return new Map(rows.flatMap((r) => (urls.get(r.fileId) ? [[r.productId, urls.get(r.fileId)!] as const] : [])));
}

/** Ảnh phân loại của một giá trị thuộc tính gắn ảnh (#340). */
export interface VariantImage {
  attributeValueId: string;
  fileId: string;
  /** Link cố định; chuỗi rỗng khi máy chủ chưa cấu hình `S3_PUBLIC_URL`. */
  url: string;
}

/**
 * Ảnh phân loại theo SKU (#340): id SKU → ảnh kèm link. Chỉ hỏi `files` khi có SKU mang ảnh, nên `getVariants` không ảnh
 * vẫn đúng 2 câu. Gọi trong `withCompany`.
 */
export async function variantImagesOf(
  rows: readonly { id: string; image: { attributeValueId: string; fileId: string } | null }[],
): Promise<Map<string, VariantImage>> {
  const withImage = rows.filter((r) => r.image);
  if (!withImage.length) return new Map();
  const urls = await publicFileUrls([...new Set(withImage.map((r) => r.image!.fileId))]);
  return new Map(withImage.map((r) => [r.id, { ...r.image!, url: urls.get(r.image!.fileId) ?? '' }]));
}

/** Ảnh phân loại của sản phẩm theo thứ tự giá trị (#340). Gọi trong `withCompany`. */
export async function attributeValueImagesOf(productId: string): Promise<VariantImage[]> {
  const rows = await variantImageRows([productId]);
  if (!rows.length) return [];
  const urls = await publicFileUrls(rows.map((r) => r.fileId));
  return rows.map((r) => ({ attributeValueId: r.attributeValueId, fileId: r.fileId, url: urls.get(r.fileId) ?? '' }));
}
