import { and, desc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { getDb } from '../../../shared/db/client.ts';
import { categories, products } from './schema.ts';

// Mọi hàm chạy trong `withCompany` của service.

const columns = {
  id: products.id,
  name: products.name,
  description: products.description,
  categoryId: products.categoryId,
  categoryName: categories.name,
  archivedAt: products.archivedAt,
  updatedAt: products.updatedAt,
  version: products.version,
  // SQL có bí danh: cột trong `sql` của Drizzle không kèm tên bảng.
  variantCount: sql<number>`(select count(*)::int from catalog.product_variants pv
    where pv.product_id = products.id and pv.archived_at is null)`,
};

export type ProductRow = NonNullable<Awaited<ReturnType<typeof findProduct>>>;

export async function findProduct(id: string) {
  const [row] = await getDb()
    .select(columns)
    .from(products)
    .innerJoin(categories, eq(categories.id, products.categoryId))
    .where(eq(products.id, id));
  return row;
}

export interface ProductFilter {
  search?: string | undefined;
  categoryId?: string | undefined;
  status: 'active' | 'archived';
  page: number;
  pageSize: number;
}

/** Tên hoặc SKU của mọi biến thể (kể cả ngừng bán) chứa `search`, không phân biệt hoa thường, không ký tự đại diện. */
export async function listProducts(filter: ProductFilter) {
  const where = and(
    filter.status === 'archived' ? isNotNull(products.archivedAt) : isNull(products.archivedAt),
    filter.categoryId ? eq(products.categoryId, filter.categoryId) : undefined,
    filter.search
      ? sql`(strpos(lower(${products.name}), lower(${filter.search})) > 0 or exists (
          select 1 from catalog.product_variants pv
          where pv.product_id = products.id and strpos(lower(pv.sku), lower(${filter.search})) > 0))`
      : undefined,
  );
  // Tuần tự: hai câu cùng một client của giao dịch, pg không cho chạy chồng.
  const rows = await getDb()
    .select(columns)
    .from(products)
    .innerJoin(categories, eq(categories.id, products.categoryId))
    .where(where)
    .orderBy(desc(products.updatedAt), products.id)
    .limit(filter.pageSize)
    .offset((filter.page - 1) * filter.pageSize);
  const [count] = await getDb().select({ total: sql<number>`count(*)::int` }).from(products).where(where);
  return { rows, total: count!.total };
}

/** Sản phẩm chưa lưu trữ cùng tên (B1: tên của sản phẩm đã lưu trữ dùng lại được). */
export async function productNameExists(name: string, exceptId?: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: products.id })
    .from(products)
    .where(
      and(
        sql`lower(${products.name}) = lower(${name})`,
        isNull(products.archivedAt),
        exceptId ? ne(products.id, exceptId) : undefined,
      ),
    );
  return rows.length > 0;
}

export async function insertProduct(companyId: string, categoryId: string, name: string, description: string) {
  const [row] = await getDb()
    .insert(products)
    .values({ companyId, categoryId, name, description })
    .returning({ id: products.id });
  return row!.id;
}

const current = (id: string, version: number) =>
  and(eq(products.id, id), eq(products.version, version), isNull(products.archivedAt));

export async function updateProductIfVersion(id: string, version: number, name: string, description: string) {
  const rows = await getDb()
    .update(products)
    .set({ name, description, version: sql`${products.version} + 1`, updatedAt: sql`now()` })
    .where(current(id, version))
    .returning({ id: products.id });
  return rows.length > 0;
}

/** Lưu trữ tăng `version` như mọi lần đổi bản ghi (C3). */
export async function archiveProductIfVersion(id: string, version: number) {
  const rows = await getDb()
    .update(products)
    .set({ archivedAt: sql`now()`, version: sql`${products.version} + 1`, updatedAt: sql`now()` })
    .where(current(id, version))
    .returning({ id: products.id });
  return rows.length > 0;
}

/** Thêm, ngừng bán biến thể: đổi `updated_at` nhưng không đổi `version` (P7). */
export async function touchProduct(id: string): Promise<void> {
  await getDb().update(products).set({ updatedAt: sql`now()` }).where(eq(products.id, id));
}
