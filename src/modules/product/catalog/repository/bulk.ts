import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { categories, productVariants, products } from './schema.ts';

// Mọi hàm chạy trong `withCompany` của service.

export interface BulkFilter {
  search?: string | undefined;
  categoryId?: string | undefined;
  /** Chỉ SKU còn ít nhất một ô trong giá muốn bán, cân nặng, ba cạnh bỏ trống. */
  incomplete: boolean;
  page: number;
  pageSize: number;
}

/** Bỏ ký tự đặc biệt của LIKE để từ khoá `50%` tìm đúng `50%`. */
const likePattern = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** SKU chưa lưu trữ, theo tên sản phẩm rồi thứ tự tạo. */
export async function findBulkVariants(filter: BulkFilter) {
  const where = and(
    isNull(productVariants.archivedAt),
    filter.categoryId ? eq(products.categoryId, filter.categoryId) : undefined,
    filter.search
      ? or(ilike(productVariants.sku, likePattern(filter.search)), ilike(products.name, likePattern(filter.search)))
      : undefined,
    filter.incomplete
      ? or(
          isNull(productVariants.targetNetPrice),
          isNull(productVariants.weightG),
          isNull(productVariants.lengthMm),
          isNull(productVariants.widthMm),
          isNull(productVariants.heightMm),
        )
      : undefined,
  );
  const [{ total }] = (await getDb()
    .select({ total: sql<number>`count(*)::int` })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(where)) as [{ total: number }];
  const rows = await getDb()
    .select({
      id: productVariants.id,
      productId: productVariants.productId,
      sku: productVariants.sku,
      productName: products.name,
      categoryId: categories.id,
      categoryName: categories.name,
      marginCoefficient: categories.marginCoefficient,
      priceRounding: categories.priceRounding,
      reorderLeadDays: categories.reorderLeadDays,
      reorderSafetyQty: categories.reorderSafetyQty,
      reorderDefaultQty: categories.reorderDefaultQty,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(categories, eq(categories.id, products.categoryId))
    .where(where)
    .orderBy(asc(products.name), asc(productVariants.createdAt), asc(productVariants.sku))
    .limit(filter.pageSize)
    .offset((filter.page - 1) * filter.pageSize);
  return { total, rows };
}

/** Mọi SKU chưa lưu trữ của các sản phẩm, SKU sửa gần nhất trước: nguồn chép cho SKU anh em (25 §5.3). */
export async function findSiblingVariants(productIds: readonly string[]) {
  if (!productIds.length) return [];
  return getDb()
    .select({
      id: productVariants.id,
      productId: productVariants.productId,
      sku: productVariants.sku,
      standardPrice: productVariants.standardPrice,
      targetNetPrice: productVariants.targetNetPrice,
      weightG: productVariants.weightG,
      lengthMm: productVariants.lengthMm,
      widthMm: productVariants.widthMm,
      heightMm: productVariants.heightMm,
    })
    .from(productVariants)
    .where(and(inArray(productVariants.productId, [...productIds]), isNull(productVariants.archivedAt)))
    .orderBy(desc(productVariants.updatedAt), asc(productVariants.sku));
}
