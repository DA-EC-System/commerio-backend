import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { attributes, attributeValues } from './schema.ts';

// Mọi hàm chạy trong `withCompany` của service.

/**
 * `created_at` lệch i micro giây theo thứ tự gửi lên: trong một giao dịch `now()` như nhau và bảng không có cột
 * thứ tự (plan #12 B9). Dùng cho giá trị thuộc tính và biến thể.
 */
export const orderedNow = (i: number) => sql`now() + ${i} * interval '1 microsecond'`;

// Subquery viết SQL có bí danh: Drizzle in cột không kèm tên bảng khi chỉ select một bảng.
const used = sql`exists (select 1 from product.variant_attribute_values vav where vav.attribute_value_id = attribute_values.id)`;

export async function findAttributes(id?: string) {
  const rows = await getDb()
    .select({
      id: attributes.id,
      name: attributes.name,
      version: attributes.version,
      // Sản phẩm có biến thể (kể cả ngừng bán) dùng một giá trị của thuộc tính (mock FE `toAttribute`).
      productCount: sql<number>`(select count(distinct pv.product_id)::int from product.product_variants pv
        join product.variant_attribute_values vav on vav.variant_id = pv.id
        join product.attribute_values av on av.id = vav.attribute_value_id
        where av.attribute_id = attributes.id)`,
    })
    .from(attributes)
    .where(id ? eq(attributes.id, id) : undefined)
    .orderBy(asc(attributes.createdAt), asc(attributes.id));
  const values = rows.length
    ? await getDb()
        .select({
          id: attributeValues.id,
          attributeId: attributeValues.attributeId,
          value: attributeValues.value,
          code: attributeValues.code,
          inUse: sql<boolean>`${used}`,
        })
        .from(attributeValues)
        .where(inArray(attributeValues.attributeId, rows.map((r) => r.id)))
        .orderBy(asc(attributeValues.createdAt), asc(attributeValues.id))
    : [];
  const byAttribute = Map.groupBy(values, (v) => v.attributeId);
  return rows.map((r) => ({
    ...r,
    values: (byAttribute.get(r.id) ?? []).map(({ attributeId: _, ...v }) => v),
  }));
}

export async function attributeNameExists(name: string, exceptId?: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: attributes.id })
    .from(attributes)
    .where(and(sql`lower(${attributes.name}) = lower(${name})`, exceptId ? ne(attributes.id, exceptId) : undefined));
  return rows.length > 0;
}

export async function insertAttribute(companyId: string, name: string): Promise<string> {
  const [row] = await getDb().insert(attributes).values({ companyId, name }).returning({ id: attributes.id });
  return row!.id;
}

export async function insertValues(companyId: string, attributeId: string, values: { value: string; code: string }[]) {
  if (!values.length) return;
  await getDb()
    .insert(attributeValues)
    .values(values.map((v, i) => ({ companyId, attributeId, value: v.value, code: v.code, createdAt: orderedNow(i) })));
}

export async function updateAttributeIfVersion(id: string, version: number, name: string): Promise<boolean> {
  const rows = await getDb()
    .update(attributes)
    .set({ name, version: sql`${attributes.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(attributes.id, id), eq(attributes.version, version)))
    .returning({ id: attributes.id });
  return rows.length > 0;
}

export async function updateValue(id: string, value: string, code: string): Promise<void> {
  await getDb()
    .update(attributeValues)
    .set({ value, code, version: sql`${attributeValues.version} + 1`, updatedAt: sql`now()` })
    .where(eq(attributeValues.id, id));
}

export async function deleteValues(ids: readonly string[]): Promise<void> {
  if (ids.length) await getDb().delete(attributeValues).where(inArray(attributeValues.id, [...ids]));
}

/** Xoá giá trị rồi thuộc tính, có điều kiện version; `false` khi người khác vừa sửa hoặc xoá. */
export async function deleteAttributeIfVersion(id: string, version: number): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: attributes.id })
    .from(attributes)
    .where(and(eq(attributes.id, id), eq(attributes.version, version)))
    .for('update');
  if (!row) return false;
  await getDb().delete(attributeValues).where(eq(attributeValues.attributeId, id));
  await getDb().delete(attributes).where(eq(attributes.id, id));
  return true;
}

/** Giá trị kèm mã thuộc tính, cho việc dựng biến thể. Id không thấy (RLS, không tồn tại) thì vắng mặt. */
export function findValuesWithAttribute(ids: readonly string[]) {
  if (!ids.length) return Promise.resolve([]);
  return getDb()
    .select({
      id: attributeValues.id,
      code: attributeValues.code,
      attributeId: attributeValues.attributeId,
    })
    .from(attributeValues)
    .where(inArray(attributeValues.id, [...ids]));
}
