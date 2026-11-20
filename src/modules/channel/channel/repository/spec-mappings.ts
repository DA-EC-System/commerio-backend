// Ánh xạ thông số của công ty sang attribute của sàn (#509, Documents/21 §18.8.1, Documents/19 mục 3.3). Chạy trong
// `withCompany` của bên gọi (RLS); `platform_category_attributes` dùng chung mọi công ty, chỉ đọc.
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { type AttributeInput, type AttributeKind, type AttributeOption, normalizePath } from '../domain/product-spec.ts';
import type { FieldMapping } from '../domain/spec-resolve.ts';
import { type Marketplace, platformCategoryAttributes, specFieldMappings, specOptionMappings } from './schema.ts';

export interface MappingCodeInput {
  attributeCode: string;
  options: { optionId: string; platformOptionId: string }[];
}

/** Mọi ánh xạ của công ty trên một sàn, kèm ánh xạ lựa chọn của từng mã; `fieldIds` để lọc (đẩy một sản phẩm). */
export async function mappingsOf(platform: Marketplace, fieldIds?: readonly string[]): Promise<FieldMapping[]> {
  if (fieldIds && fieldIds.length === 0) return [];
  const db = getDb();
  const fieldFilter = fieldIds ? inArray(specFieldMappings.fieldId, [...fieldIds]) : undefined;
  const rows = await db
    .select()
    .from(specFieldMappings)
    .where(and(eq(specFieldMappings.platform, platform), fieldFilter))
    .orderBy(asc(specFieldMappings.fieldId), asc(specFieldMappings.priority));
  if (!rows.length) return [];
  const opts = await db
    .select()
    .from(specOptionMappings)
    .where(and(eq(specOptionMappings.platform, platform), fieldIds ? inArray(specOptionMappings.fieldId, [...fieldIds]) : undefined));
  const byKey = new Map<string, Map<string, string>>();
  for (const o of opts) {
    const key = `${o.fieldId}\u0000${o.attributeCode}`;
    if (!byKey.has(key)) byKey.set(key, new Map());
    byKey.get(key)!.set(o.optionId, o.platformOptionId);
  }
  return rows.map((r) => ({
    fieldId: r.fieldId,
    attributeCode: r.attributeCode,
    priority: r.priority,
    options: byKey.get(`${r.fieldId}\u0000${r.attributeCode}`) ?? new Map(),
  }));
}

/** Mã trong `codes` đã ánh xạ cho thông số khác trên sàn này (unique `(company_id, platform, attribute_code)`). */
export async function codesTakenByOthers(platform: Marketplace, fieldId: string, codes: readonly string[]): Promise<Set<string>> {
  if (!codes.length) return new Set();
  const rows = await getDb()
    .select({ code: specFieldMappings.attributeCode })
    .from(specFieldMappings)
    .where(and(eq(specFieldMappings.platform, platform), ne(specFieldMappings.fieldId, fieldId), inArray(specFieldMappings.attributeCode, [...codes])));
  return new Set(rows.map((r) => r.code));
}

/** Thay cả tập mã của một thông số trên một sàn; thứ tự mảng là `priority`. Xoá mã thì CSDL xoá ánh xạ lựa chọn (cascade). */
export async function replaceFieldMapping(companyId: string, platform: Marketplace, fieldId: string, codes: readonly MappingCodeInput[]): Promise<void> {
  const db = getDb();
  await db.delete(specFieldMappings).where(and(eq(specFieldMappings.fieldId, fieldId), eq(specFieldMappings.platform, platform)));
  if (!codes.length) return;
  await db.insert(specFieldMappings).values(codes.map((c, i) => ({ companyId, fieldId, platform, attributeCode: c.attributeCode, priority: i + 1 })));
  const options = codes.flatMap((c) =>
    c.options.map((o) => ({ companyId, fieldId, optionId: o.optionId, platform, attributeCode: c.attributeCode, platformOptionId: o.platformOptionId })),
  );
  if (options.length) await db.insert(specOptionMappings).values(options);
}

/** Ánh xạ mặc định khi tạo công ty; dòng trùng (mã đã có) bỏ qua để chạy lại được. */
export async function seedFieldMappings(
  companyId: string,
  platform: Marketplace,
  rows: readonly { fieldId: string; attributeCode: string; priority: number }[],
): Promise<void> {
  if (!rows.length) return;
  await getDb()
    .insert(specFieldMappings)
    .values(rows.map((r) => ({ ...r, companyId, platform })))
    .onConflictDoNothing();
}

/** Dọn khi catalog xoá thông số (`catalog.spec_field_deleted`). */
export async function deleteFieldMappings(fieldId: string): Promise<void> {
  await getDb().delete(specFieldMappings).where(eq(specFieldMappings.fieldId, fieldId));
}

/** Dọn khi catalog xoá lựa chọn (`catalog.spec_option_deleted`). */
export async function deleteOptionMappings(optionIds: readonly string[]): Promise<void> {
  if (!optionIds.length) return;
  await getDb().delete(specOptionMappings).where(inArray(specOptionMappings.optionId, [...optionIds]));
}

export interface CatalogAttribute {
  code: string;
  label: string;
  kind: AttributeKind;
  input: AttributeInput;
  options: AttributeOption[];
}

/** Gộp các dòng leaf của cùng một mã: nhãn của dòng đầu, lựa chọn gộp bỏ trùng theo id. */
function mergeByCode(rows: readonly CatalogAttribute[]): CatalogAttribute[] {
  const out = new Map<string, CatalogAttribute & { seen: Set<string> }>();
  for (const r of rows) {
    let m = out.get(r.code);
    if (!m) {
      m = { code: r.code, label: r.label, kind: r.kind, input: r.input, options: [], seen: new Set() };
      out.set(r.code, m);
    }
    for (const o of r.options) {
      if (m.seen.has(o.id)) continue;
      m.seen.add(o.id);
      m.options.push(o);
    }
  }
  return [...out.values()].map(({ seen: _seen, ...a }) => a);
}

const attrColumns = {
  code: platformCategoryAttributes.code,
  label: platformCategoryAttributes.label,
  kind: platformCategoryAttributes.kind,
  input: platformCategoryAttributes.input,
  options: platformCategoryAttributes.options,
};

/** Attribute đã gặp ở các leaf đã lấy của sàn, gộp theo mã, tìm theo nhãn hoặc mã, tối đa `limit` mã (§18.8.1). */
export async function searchAttributeCatalog(
  platform: Marketplace,
  search: string,
  kind: AttributeKind | undefined,
  limit = 50,
): Promise<CatalogAttribute[]> {
  // So không dấu, không phân biệt hoa thường trên nhãn và mã (người dùng gõ "mau" vẫn ra "Màu sắc"): lọc trong bộ nhớ, bảng
  // attribute leaf của một sàn chỉ vài nghìn dòng (staging 21/11/2026: Lazada 1784, TikTok 216).
  const needle = normalizePath(search);
  const rows = await getDb()
    .select(attrColumns)
    .from(platformCategoryAttributes)
    .where(and(eq(platformCategoryAttributes.platform, platform), kind ? eq(platformCategoryAttributes.kind, kind) : undefined))
    .orderBy(asc(platformCategoryAttributes.code));
  const hits = rows.filter((r) => normalizePath(r.label).includes(needle) || normalizePath(r.code).includes(needle));
  return mergeByCode(hits).slice(0, limit);
}

/** Attribute gộp theo mã cho các mã cho trước (nhãn, lựa chọn để kiểm `PUT` và hiện ở `GET`). */
export async function attributesByCodes(platform: Marketplace, codes: readonly string[]): Promise<Map<string, CatalogAttribute>> {
  if (!codes.length) return new Map();
  const rows = await getDb()
    .select(attrColumns)
    .from(platformCategoryAttributes)
    .where(and(eq(platformCategoryAttributes.platform, platform), inArray(platformCategoryAttributes.code, [...new Set(codes)])));
  return new Map(mergeByCode(rows).map((a) => [a.code, a]));
}

/** Mọi attribute `property` của sàn gộp theo mã (gợi ý ánh xạ theo nhãn, §18.8.1). */
export async function propertyAttributesOf(platform: Marketplace): Promise<CatalogAttribute[]> {
  const rows = await getDb()
    .select(attrColumns)
    .from(platformCategoryAttributes)
    .where(and(eq(platformCategoryAttributes.platform, platform), eq(platformCategoryAttributes.kind, 'property')));
  return mergeByCode(rows);
}
