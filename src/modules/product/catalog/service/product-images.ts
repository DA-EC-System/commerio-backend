// Ảnh sản phẩm (#303; Documents/21 §5.2, §5.4 P8, P10). Tệp và link ảnh ở module `files` (bucket công khai).
import { publicFileUrls } from '../../../core/index.ts';
import { productImageRows } from '../repository/product-images.ts';

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
