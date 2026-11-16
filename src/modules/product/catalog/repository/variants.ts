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

type BusinessStatus = (typeof productVariants.businessStatus.enumValues)[number];

/**
 * Đổi trạng thái kinh doanh khi SKU còn ở `from` (#204): `archived_at` có giá trị đúng khi sang `archived` (CHECK
 * `product_variants_archived`), tăng `version`. Không trúng dòng (trạng thái vừa đổi) thì `undefined`.
 */
export async function setBusinessStatus(id: string, from: BusinessStatus, to: BusinessStatus) {
  const [row] = await getDb()
    .update(productVariants)
    .set({
      businessStatus: to,
      archivedAt: to === 'archived' ? sql`now()` : null,
      version: sql`${productVariants.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(productVariants.id, id), eq(productVariants.businessStatus, from)))
    .returning({ updatedAt: productVariants.updatedAt });
  return row;
}

/** Trường của SKU mà PATCH sửa được (#204); giá là chuỗi `numeric`. Khoá vắng mặt thì giữ nguyên, `null` là xoá. */
export type VariantPatch = Partial<{
  standardPrice: string | null;
  targetNetPrice: string | null;
  weightG: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
}>;

/**
 * Ghi khi `version` còn đúng, tăng `version` của SKU. Không trúng dòng (người khác vừa sửa) thì `undefined`. Câu UPDATE
 * khoá dòng SKU tới hết giao dịch: sự kiện ghi outbox sau đó giữ đúng thứ tự theo SKU (outbox/README.md).
 */
export async function updateVariantIfVersion(id: string, version: number, patch: VariantPatch) {
  const [row] = await getDb()
    .update(productVariants)
    .set({ ...patch, version: sql`${productVariants.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(productVariants.id, id), eq(productVariants.version, version)))
    .returning({
      version: productVariants.version,
      updatedAt: productVariants.updatedAt,
      targetNetPrice: productVariants.targetNetPrice,
    });
  return row;
}

/** Biến thể kèm sản phẩm, danh mục và giá trị thuộc tính theo `position`; theo thứ tự tạo. */
export async function findVariants(filter: { productId?: string; ids?: readonly string[] } = {}) {
  const rows = await getDb()
    .select({
      id: productVariants.id,
      productId: productVariants.productId,
      sku: productVariants.sku,
      archivedAt: productVariants.archivedAt,
      businessStatus: productVariants.businessStatus,
      version: productVariants.version,
      standardPrice: productVariants.standardPrice,
      targetNetPrice: productVariants.targetNetPrice,
      weightG: productVariants.weightG,
      lengthMm: productVariants.lengthMm,
      widthMm: productVariants.widthMm,
      heightMm: productVariants.heightMm,
      productName: products.name,
      description: products.description,
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

/** Giá chuẩn và giá muốn bán của các biến thể (chuỗi `numeric`, trống khi chưa đặt). */
export async function variantPrices(
  ids: readonly string[],
): Promise<{ id: string; standardPrice: string | null; targetNetPrice: string | null }[]> {
  return getDb()
    .select({ id: productVariants.id, standardPrice: productVariants.standardPrice, targetNetPrice: productVariants.targetNetPrice })
    .from(productVariants)
    .where(inArray(productVariants.id, [...ids]));
}
