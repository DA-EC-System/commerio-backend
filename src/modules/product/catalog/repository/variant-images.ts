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

/**
 * Sản phẩm có ảnh phân loại một phần (#340, Documents/21 §17.1): giá trị đang dùng là giá trị của thuộc tính gắn ảnh mà
 * SKU chưa lưu trữ mang; có giá trị đang dùng có ảnh và có giá trị đang dùng chưa ảnh. Một câu cho cả lô.
 */
export async function partialVariantImageProducts(productIds: readonly string[]): Promise<Set<string>> {
  if (!productIds.length) return new Set();
  const { rows } = await getDb().execute<{ product_id: string }>(sql`
    select pv.product_id
    from product.product_variants pv
    join product.products p on p.id = pv.product_id
    join product.variant_attribute_values vav on vav.variant_id = pv.id
    join product.attribute_values av on av.id = vav.attribute_value_id and av.attribute_id = p.image_attribute_id
    left join product.product_attribute_value_images pavi
      on pavi.product_id = pv.product_id and pavi.attribute_value_id = vav.attribute_value_id
    where pv.archived_at is null and pv.product_id in (${sql.join(productIds.map((id) => sql`${id}`), sql`, `)})
    group by pv.product_id
    having bool_or(pavi.id is not null) and not bool_and(pavi.id is not null)`);
  return new Set(rows.map((r) => r.product_id));
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
