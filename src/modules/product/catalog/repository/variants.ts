import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { orderedNow } from './attributes.ts';
import { attributes, attributeValues, categories, products, productVariants, variantAttributeValues } from './schema.ts';

// Mọi hàm chạy trong `withCompany` của service.

/**
 * Khoá theo công ty cho mọi thao tác đổi tập biến thể (cấp SKU, thêm, ngừng bán; plan #12 B5). Tự nhả khi giao dịch
 * kết thúc. Lấy ở đầu giao dịch, trước khi đọc biến thể, để hai request song song không cùng thấy một trạng thái cũ.
 */
export async function lockVariants(companyId: string): Promise<void> {
  await getDb().execute(sql`select pg_advisory_xact_lock(hashtextextended(${`catalog.sku:${companyId}`}, 0))`);
}

export async function skuTaken(sku: string): Promise<boolean> {
  const rows = await getDb().select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.sku, sku));
  return rows.length > 0;
}

/** Biến thể và tổ hợp giá trị; `valueIds` đã theo thứ tự thuộc tính của sản phẩm (`position`). */
export async function insertVariant(companyId: string, productId: string, sku: string, valueIds: readonly string[], order: number) {
  const [row] = await getDb()
    .insert(productVariants)
    .values({ companyId, productId, sku, createdAt: orderedNow(order) })
    .returning({ id: productVariants.id });
  if (valueIds.length) {
    await getDb()
      .insert(variantAttributeValues)
      .values(valueIds.map((attributeValueId, position) => ({ variantId: row!.id, attributeValueId, position, companyId })));
  }
  return row!.id;
}

export async function setVariantArchived(id: string, archived: boolean): Promise<void> {
  await getDb()
    .update(productVariants)
    .set({
      archivedAt: archived ? sql`now()` : null,
      version: sql`${productVariants.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(eq(productVariants.id, id));
}

/** Biến thể kèm sản phẩm, danh mục và giá trị thuộc tính theo `position`; theo thứ tự tạo. */
export async function findVariants(filter: { productId?: string; ids?: readonly string[] } = {}) {
  const rows = await getDb()
    .select({
      id: productVariants.id,
      productId: productVariants.productId,
      sku: productVariants.sku,
      archivedAt: productVariants.archivedAt,
      productName: products.name,
      productArchivedAt: products.archivedAt,
      categoryId: categories.id,
      categoryName: categories.name,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(categories, eq(categories.id, products.categoryId))
    .where(
      and(
        filter.productId ? eq(productVariants.productId, filter.productId) : undefined,
        filter.ids ? inArray(productVariants.id, [...filter.ids]) : undefined,
      ),
    )
    .orderBy(asc(productVariants.createdAt), asc(productVariants.sku));
  if (!rows.length) return [];
  const values = await getDb()
    .select({
      variantId: variantAttributeValues.variantId,
      attributeId: attributes.id,
      attributeName: attributes.name,
      valueId: attributeValues.id,
      value: attributeValues.value,
      code: attributeValues.code,
    })
    .from(variantAttributeValues)
    .innerJoin(attributeValues, eq(attributeValues.id, variantAttributeValues.attributeValueId))
    .innerJoin(attributes, eq(attributes.id, attributeValues.attributeId))
    .where(inArray(variantAttributeValues.variantId, rows.map((r) => r.id)))
    .orderBy(asc(variantAttributeValues.position));
  const byVariant = Map.groupBy(values, (v) => v.variantId);
  return rows.map((r) => ({
    ...r,
    attributes: (byVariant.get(r.id) ?? []).map(({ variantId: _, ...v }) => v),
  }));
}

export type VariantRow = Awaited<ReturnType<typeof findVariants>>[number];
