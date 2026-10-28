// Ghép danh mục Commerio → danh mục sàn (#104 A2). Chạy trong `withCompany` của bên gọi.
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { categoryMaps } from './schema.ts';

export type CategoryMapRow = typeof categoryMaps.$inferSelect;
type Platform = CategoryMapRow['platform'];

export async function listCategoryMaps(platform: Platform, categoryIds?: readonly string[]): Promise<CategoryMapRow[]> {
  const byCategory = categoryIds ? inArray(categoryMaps.categoryId, [...categoryIds]) : undefined;
  return getDb()
    .select()
    .from(categoryMaps)
    .where(and(eq(categoryMaps.platform, platform), byCategory))
    .orderBy(asc(categoryMaps.createdAt));
}

export async function insertCategoryMap(values: typeof categoryMaps.$inferInsert): Promise<CategoryMapRow | undefined> {
  const [row] = await getDb().insert(categoryMaps).values(values).onConflictDoNothing().returning();
  return row;
}

/** Sửa khi còn đúng `version`; không trúng dòng thì `undefined`. */
export async function updateCategoryMap(
  platform: Platform,
  categoryId: string,
  version: number,
  patch: Pick<CategoryMapRow, 'externalCategoryId' | 'attributes'>,
): Promise<CategoryMapRow | undefined> {
  const [row] = await getDb()
    .update(categoryMaps)
    .set({ ...patch, version: sql`${categoryMaps.version} + 1`, updatedAt: sql`now()` })
    .where(
      and(eq(categoryMaps.platform, platform), eq(categoryMaps.categoryId, categoryId), eq(categoryMaps.version, version)),
    )
    .returning();
  return row;
}
