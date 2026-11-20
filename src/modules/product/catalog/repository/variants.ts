import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDb, requireCompanyId } from '../../../../shared/db/client.ts';
import { orderedNow } from './attributes.ts';
import {
  attributes,
  attributeValues,
  productGroups,
  productAttributeValueImages,
  products,
  productVariants,
  variantAttributeValues,
} from './schema.ts';

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
/** `sourceRequestLineId`: dòng đề nghị nhập sinh ra SKU (#243), chặn xoá hẳn sản phẩm. */
export async function insertVariant(
  companyId: string,
  productId: string,
  sku: string,
  valueIds: readonly string[],
  order: number,
  sourceRequestLineId: string | null = null,
  prices: { standardPrice?: string | null; targetNetPrice?: string | null } = {},
) {
  const [row] = await getDb()
    .insert(productVariants)
    .values({ companyId, productId, sku, sourceRequestLineId, createdAt: orderedNow(order), ...prices })
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

/**
 * Đưa SKU đang `archived` về `discontinued` (hệ thống tự khôi phục khi có hàng vào, #204). Một câu cho cả lô; SKU không
 * ở `archived` thì không đổi, không khoá chờ. Trả các dòng đã đổi.
 */
export async function restoreArchivedRows(ids: readonly string[]) {
  if (!ids.length) return [];
  // Khoá theo id tăng dần trước khi ghi: UPDATE khoá theo thứ tự quét, có thể ngược với thao tác người dùng trên nhiều
  // SKU (cũng theo id) và khoá chéo (review PR 2).
  await getDb()
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(and(inArray(productVariants.id, [...ids]), eq(productVariants.businessStatus, 'archived')))
    .orderBy(asc(productVariants.id))
    .for('update');
  return getDb()
    .update(productVariants)
    .set({ businessStatus: 'discontinued', archivedAt: null, version: sql`${productVariants.version} + 1`, updatedAt: sql`now()` })
    .where(and(inArray(productVariants.id, [...ids]), eq(productVariants.businessStatus, 'archived')))
    .returning({ id: productVariants.id, productId: productVariants.productId, updatedAt: productVariants.updatedAt });
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

/**
 * Biến thể kèm sản phẩm, nhóm hàng và giá trị thuộc tính theo `position`; theo thứ tự tạo. Đúng 2 câu (inventory gọi khi
 * đang khoá dòng tồn). `image`: tệp ảnh phân loại theo giá trị của SKU ở thuộc tính gắn ảnh (#340), null khi chưa có.
 */
export async function findVariants(filter: { productId?: string; productIds?: readonly string[]; ids?: readonly string[] } = {}) {
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
      sourceRequestLineId: productVariants.sourceRequestLineId,
      productName: products.name,
      productCode: products.code,
      description: products.description,
      originCountry: products.originCountry,
      brand: products.brand,
      groupId: productGroups.id,
      groupName: productGroups.name,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(productGroups, eq(productGroups.id, products.groupId))
    .where(
      and(
        filter.productId ? eq(productVariants.productId, filter.productId) : undefined,
        filter.productIds ? inArray(productVariants.productId, [...filter.productIds]) : undefined,
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
      platformKind: attributes.platformKind,
      valueId: attributeValues.id,
      value: attributeValues.value,
      code: attributeValues.code,
      imageFileId: productAttributeValueImages.fileId,
    })
    .from(variantAttributeValues)
    .innerJoin(attributeValues, eq(attributeValues.id, variantAttributeValues.attributeValueId))
    .innerJoin(attributes, eq(attributes.id, attributeValues.attributeId))
    .innerJoin(productVariants, eq(productVariants.id, variantAttributeValues.variantId))
    // Giá trị thuộc tính là cấp công ty: ảnh phải khớp cả sản phẩm. Khoá ngoại ghép bảo đảm dòng ảnh khớp luôn thuộc
    // thuộc tính gắn ảnh hiện tại, nên không lọc thêm theo thuộc tính.
    .leftJoin(
      productAttributeValueImages,
      and(
        eq(productAttributeValueImages.productId, productVariants.productId),
        eq(productAttributeValueImages.attributeValueId, variantAttributeValues.attributeValueId),
      ),
    )
    .where(inArray(variantAttributeValues.variantId, rows.map((r) => r.id)))
    .orderBy(asc(variantAttributeValues.position));
  const byVariant = Map.groupBy(values, (v) => v.variantId);
  return rows.map((r) => {
    const own = byVariant.get(r.id) ?? [];
    const withImage = own.find((v) => v.imageFileId);
    return {
      ...r,
      attributes: own.map(({ variantId: _, imageFileId: __, ...v }) => v),
      image: withImage ? { attributeValueId: withImage.valueId, fileId: withImage.imageFileId! } : null,
    };
  });
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

/** Khoá mọi dòng SKU của sản phẩm theo id tăng dần (xoá hẳn, #204): cùng thứ tự với đổi trạng thái kinh doanh. */
export async function lockProductVariants(productId: string): Promise<void> {
  await getDb()
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(eq(productVariants.productId, productId))
    .orderBy(asc(productVariants.id))
    .for('update');
}

/** Công ty đang chọn có variant chưa lưu trữ nào chưa (#461 onboarding, Documents/21 mục 11.3). */
export async function hasCatalogData(): Promise<boolean> {
  const companyId = requireCompanyId('hasCatalogData');
  const [row] = await getDb()
    .select({ one: sql`1` })
    .from(productVariants)
    .where(and(eq(productVariants.companyId, companyId), isNull(productVariants.archivedAt)))
    .limit(1);
  return !!row;
}
