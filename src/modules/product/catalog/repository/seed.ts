import { sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { DEFAULT_ATTRIBUTES, DEFAULT_GROUPS } from '../domain/defaults.ts';
import { attributes, attributeValues, companyProductSettings, productGroups } from './schema.ts';

// Chạy trong giao dịch đăng ký (role chủ bảng, chưa có `app.company_id`): ghi `company_id` tường minh.
// `created_at` tăng dần theo thứ tự khai để danh sách hiện đúng thứ tự (sắp theo `created_at`, `id`).
const at = (i: number) => sql`now() + ${i} * interval '1 millisecond'`;

export async function insertCompanyDefaults(companyId: string): Promise<void> {
  const db = getDb();
  await db.insert(companyProductSettings).values({ companyId });
  await db.insert(productGroups).values(DEFAULT_GROUPS.map((name, i) => ({ companyId, name, createdAt: at(i) })));
  for (const [i, attr] of DEFAULT_ATTRIBUTES.entries()) {
    const [row] = await db
      .insert(attributes)
      .values({ companyId, name: attr.name, platformKind: attr.kind, createdAt: at(i) })
      .returning({ id: attributes.id });
    await db
      .insert(attributeValues)
      .values(attr.values.map(([value, code], j) => ({ companyId, attributeId: row!.id, value, code, createdAt: at(j) })));
  }
}
