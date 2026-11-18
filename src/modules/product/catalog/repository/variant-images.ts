import { asc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { attributeValues, productAttributeValueImages } from './schema.ts';

// Ảnh phân loại theo giá trị của thuộc tính gắn ảnh (#340). Mọi hàm chạy trong `withCompany` của service. `file_id` ở
// module `files`: link lấy bằng `publicFileUrls`, không join `core.files`.

export interface VariantImageRow {
  productId: string;
  attributeValueId: string;
  fileId: string;
}

/** Ảnh phân loại của các sản phẩm, theo thứ tự giá trị trong thuộc tính (thứ tự tạo giá trị). */
export async function variantImageRows(productIds: readonly string[]): Promise<VariantImageRow[]> {
  if (!productIds.length) return [];
  return getDb()
    .select({
      productId: productAttributeValueImages.productId,
      attributeValueId: productAttributeValueImages.attributeValueId,
      fileId: productAttributeValueImages.fileId,
    })
    .from(productAttributeValueImages)
    .innerJoin(attributeValues, eq(attributeValues.id, productAttributeValueImages.attributeValueId))
    .where(inArray(productAttributeValueImages.productId, [...productIds]))
    .orderBy(asc(attributeValues.createdAt), asc(attributeValues.id));
}

/** Gỡ mọi ảnh phân loại của sản phẩm (đổi thuộc tính gắn ảnh); không xoá tệp. */
export async function deleteVariantImages(productId: string): Promise<void> {
  await getDb().delete(productAttributeValueImages).where(eq(productAttributeValueImages.productId, productId));
}
