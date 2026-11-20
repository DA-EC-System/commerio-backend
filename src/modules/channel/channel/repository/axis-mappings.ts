// Ánh xạ trục phân loại của công ty sang sales attribute của sàn (#448, Documents/19 §3.3). Chạy trong `withCompany` (RLS).
import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { axisMappings, type Marketplace } from './schema.ts';

/** Mã sales attribute theo `priority` của từng thuộc tính phân loại trên một sàn. */
export async function axisCodesOf(platform: Marketplace): Promise<Map<string, string[]>> {
  const rows = await getDb()
    .select({ attributeId: axisMappings.attributeId, code: axisMappings.attributeCode })
    .from(axisMappings)
    .where(eq(axisMappings.platform, platform))
    .orderBy(asc(axisMappings.attributeId), asc(axisMappings.priority));
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.attributeId, [...(out.get(r.attributeId) ?? []), r.code]);
  return out;
}

/** Thay cả danh sách của một (thuộc tính, sàn): xoá rồi chèn theo thứ tự (`priority` từ 1). `[]` là bỏ hết. */
export async function replaceAxisCodes(
  companyId: string,
  attributeId: string,
  platform: Marketplace,
  codes: readonly string[],
): Promise<void> {
  const db = getDb();
  await db.delete(axisMappings).where(and(eq(axisMappings.attributeId, attributeId), eq(axisMappings.platform, platform)));
  if (!codes.length) return;
  await db
    .insert(axisMappings)
    .values(codes.map((attributeCode, i) => ({ companyId, attributeId, platform, attributeCode, priority: i + 1 })));
}
