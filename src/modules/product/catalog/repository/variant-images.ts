import { and, asc, eq, inArray, sql } from 'drizzle-orm';
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

/** Đặt hoặc thay ảnh của một giá trị; bên gọi đã khoá dòng sản phẩm và kiểm giá trị thuộc thuộc tính gắn ảnh. */
export async function upsertVariantImage(row: {
  companyId: string;
  productId: string;
  attributeId: string;
  attributeValueId: string;
  fileId: string;
}): Promise<void> {
  await getDb()
    .insert(productAttributeValueImages)
    .values(row)
    .onConflictDoUpdate({
      target: [productAttributeValueImages.productId, productAttributeValueImages.attributeValueId],
      set: { fileId: row.fileId, updatedAt: sql`now()`, version: sql`${productAttributeValueImages.version} + 1` },
    });
}

/** Gỡ ảnh của một giá trị; không xoá tệp. */
export async function deleteVariantImage(productId: string, attributeValueId: string): Promise<void> {
  await getDb()
    .delete(productAttributeValueImages)
    .where(and(eq(productAttributeValueImages.productId, productId), eq(productAttributeValueImages.attributeValueId, attributeValueId)));
}
