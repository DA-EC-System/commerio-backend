import { and, asc, eq, inArray, lt } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { productImages } from './schema.ts';

// Ảnh sản phẩm theo thứ tự (#303). Mọi hàm chạy trong `withCompany` của service. `file_id` trỏ `core.files` (module
// `files`): không join chéo schema, link ảnh lấy bằng `publicFileUrls` của `files`.

export interface ProductImageRow {
  id: string;
  productId: string;
  fileId: string;
  position: number;
}

/** Ảnh của các sản phẩm, xếp theo sản phẩm rồi `position`; có `max` thì chỉ `position < max`. */
export async function productImageRows(productIds: readonly string[], max?: number): Promise<ProductImageRow[]> {
  if (productIds.length === 0) return [];
  return getDb()
    .select({ id: productImages.id, productId: productImages.productId, fileId: productImages.fileId, position: productImages.position })
    .from(productImages)
    .where(and(inArray(productImages.productId, [...productIds]), max === undefined ? undefined : lt(productImages.position, max)))
    .orderBy(asc(productImages.productId), asc(productImages.position));
}

/** Thay toàn bộ ảnh của sản phẩm theo thứ tự `fileIds` (`position` 0 là ảnh đại diện). Gỡ ảnh không xoá tệp. */
export async function replaceProductImages(companyId: string, productId: string, fileIds: readonly string[]): Promise<void> {
  await getDb().delete(productImages).where(eq(productImages.productId, productId));
  if (fileIds.length === 0) return;
  await getDb()
    .insert(productImages)
    .values(fileIds.map((fileId, position) => ({ companyId, productId, fileId, position })));
}
