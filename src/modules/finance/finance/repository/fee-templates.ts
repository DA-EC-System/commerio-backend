// Biểu phí mẫu của nền tảng (Documents/21 §21.6): bảng không theo công ty, `commerio_app` chỉ đọc; ghi bằng role chủ bảng
// ngoài `withCompany` (route quản trị nền tảng, migration).
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { feeTemplates } from './schema.ts';

export type FeeTemplateRow = typeof feeTemplates.$inferSelect;

export function findFeeTemplates(platform?: string): Promise<FeeTemplateRow[]> {
  return getDb()
    .select()
    .from(feeTemplates)
    .where(platform ? eq(feeTemplates.platform, platform) : undefined)
    .orderBy(asc(feeTemplates.platform), asc(feeTemplates.shopType));
}

export async function findFeeTemplate(id: string): Promise<FeeTemplateRow | undefined> {
  const [row] = await getDb().select().from(feeTemplates).where(eq(feeTemplates.id, id));
  return row;
}

/** `version` hiện tại của các mẫu, để nhắc cấu hình dựng từ mẫu cũ. */
export async function feeTemplateVersions(ids: readonly string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const rows = await getDb()
    .select({ id: feeTemplates.id, version: feeTemplates.version })
    .from(feeTemplates)
    .where(inArray(feeTemplates.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r.version]));
}

export async function insertFeeTemplate(values: typeof feeTemplates.$inferInsert): Promise<FeeTemplateRow> {
  const [row] = await getDb().insert(feeTemplates).values(values).returning();
  return row!;
}

/** Sửa theo `version`; lệch thì trả `undefined` để bên gọi báo 409. */
export async function updateFeeTemplateIfVersion(
  id: string,
  version: number,
  set: Pick<typeof feeTemplates.$inferInsert, 'shopTypeLabel' | 'payload' | 'sources' | 'effectiveFrom' | 'note' | 'updatedBy'>,
): Promise<FeeTemplateRow | undefined> {
  const [row] = await getDb()
    .update(feeTemplates)
    .set({ ...set, version: sql`${feeTemplates.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(feeTemplates.id, id), eq(feeTemplates.version, version)))
    .returning();
  return row;
}
