// Điền trường đang trống từ sàn (#497, Documents/21 §11.3 `fillProductFacts`). Chạy trong `withCompany` của bên gọi.
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { products, productVariants } from './schema.ts';

export interface ProductFactsRow {
  id: string;
  name: string;
  description: string | null;
  originCountry: string | null;
  brand: string | null;
  sizeChartFileId: string | null;
}

/** Khoá dòng sản phẩm (`FOR UPDATE`) và đọc các trường điền được; không có thì `undefined`. */
export async function lockProductFacts(id: string): Promise<ProductFactsRow | undefined> {
  const [row] = await getDb()
    .select({ id: products.id, name: products.name, description: products.description, originCountry: products.originCountry, brand: products.brand, sizeChartFileId: products.sizeChartFileId })
    .from(products)
    .where(eq(products.id, id))
    .for('update');
  return row;
}

export type ProductFactsPatch = Partial<Pick<ProductFactsRow, 'description' | 'originCountry' | 'brand' | 'sizeChartFileId'>>;

/** Ghi các trường đã chọn, tăng `version`; dòng đã khoá ở `lockProductFacts`. */
export async function writeProductFacts(id: string, patch: ProductFactsPatch): Promise<void> {
  await getDb()
    .update(products)
    .set({ ...patch, version: sql`${products.version} + 1`, updatedAt: sql`now()` })
    .where(eq(products.id, id));
}

export interface VariantMeasuresRow {
  id: string;
  sku: string;
  weightG: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
}

/** Khoá SKU của sản phẩm theo thứ tự id (`FOR UPDATE`), chỉ các id cho trước; SKU sản phẩm khác không có trong kết quả. */
export async function lockVariantMeasures(productId: string, ids: readonly string[]): Promise<VariantMeasuresRow[]> {
  if (!ids.length) return [];
  return getDb()
    .select({
      id: productVariants.id,
      sku: productVariants.sku,
      weightG: productVariants.weightG,
      lengthMm: productVariants.lengthMm,
      widthMm: productVariants.widthMm,
      heightMm: productVariants.heightMm,
    })
    .from(productVariants)
    .where(and(eq(productVariants.productId, productId), inArray(productVariants.id, [...ids])))
    .orderBy(asc(productVariants.id))
    .for('update');
}

export type VariantMeasuresPatch = Partial<Pick<VariantMeasuresRow, 'weightG' | 'lengthMm' | 'widthMm' | 'heightMm'>>;

/** Ghi cân nặng, kích thước, tăng `version` SKU; dòng đã khoá ở `lockVariantMeasures`. */
export async function writeVariantMeasures(id: string, patch: VariantMeasuresPatch): Promise<void> {
  await getDb()
    .update(productVariants)
    .set({ ...patch, version: sql`${productVariants.version} + 1`, updatedAt: sql`now()` })
    .where(eq(productVariants.id, id));
}
