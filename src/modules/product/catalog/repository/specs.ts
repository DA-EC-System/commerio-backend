import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import {
  attributes,
  attributeValues,
  groupSpecFields,
  productGroups,
  productSpecValues,
  type SpecInput,
  specFieldOptions,
  specFields,
} from './schema.ts';

// Thông số sản phẩm (Documents/21 mục 5.5, 19 §3.2). Mọi hàm chạy trong `withCompany` của service.
// Subquery viết SQL có bí danh: Drizzle in cột không kèm tên bảng khi chỉ select một bảng.

const optionUsed = sql`exists (select 1 from product.product_spec_values psv where psv.option_id = spec_field_options.id)`;

export async function findSpecFields(id?: string) {
  const rows = await getDb()
    .select({
      id: specFields.id,
      code: specFields.code,
      name: specFields.name,
      input: specFields.input,
      unit: specFields.unit,
      allowCustom: specFields.allowCustom,
      groupCount: sql<number>`(select count(*)::int from product.group_spec_fields g where g.field_id = spec_fields.id)`,
      productCount: sql<number>`(select count(distinct v.product_id)::int from product.product_spec_values v where v.field_id = spec_fields.id)`,
      updatedAt: specFields.updatedAt,
      version: specFields.version,
    })
    .from(specFields)
    .where(id ? eq(specFields.id, id) : undefined);
  const options = rows.length ? await findOptions(rows.map((r) => r.id)) : [];
  const byField = Map.groupBy(options, (o) => o.fieldId);
  return rows.map((r) => ({
    ...r,
    options: (byField.get(r.id) ?? []).map(({ fieldId: _, ...o }) => o),
  }));
}

export function findOptions(fieldIds: readonly string[]) {
  return getDb()
    .select({
      id: specFieldOptions.id,
      fieldId: specFieldOptions.fieldId,
      value: specFieldOptions.value,
      position: specFieldOptions.position,
      inUse: sql<boolean>`${optionUsed}`,
    })
    .from(specFieldOptions)
    .where(inArray(specFieldOptions.fieldId, [...fieldIds]))
    .orderBy(asc(specFieldOptions.position), asc(specFieldOptions.id));
}

export async function specFieldNameExists(name: string, exceptId?: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: specFields.id })
    .from(specFields)
    .where(and(sql`lower(${specFields.name}) = lower(${name})`, exceptId ? ne(specFields.id, exceptId) : undefined));
  return rows.length > 0;
}

/** Mã đã dùng bắt đầu bằng `base` (để sinh hậu tố số). */
export async function specCodesLike(base: string): Promise<Set<string>> {
  const rows = await getDb()
    .select({ code: specFields.code })
    .from(specFields)
    .where(sql`${specFields.code} = ${base} or ${specFields.code} like ${`${base}\\_%`}`);
  return new Set(rows.map((r) => r.code));
}

export async function insertSpecField(
  companyId: string,
  f: {
    code: string;
    name: string;
    input: SpecInput;
    unit: string | null;
    allowCustom: boolean;
  },
): Promise<string> {
  const [row] = await getDb()
    .insert(specFields)
    .values({ companyId, ...f })
    .returning({ id: specFields.id });
  return row!.id;
}

export async function updateSpecFieldIfVersion(
  id: string,
  version: number,
  f: { name: string; unit: string | null; allowCustom: boolean },
): Promise<boolean> {
  const rows = await getDb()
    .update(specFields)
    .set({
      ...f,
      version: sql`${specFields.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(specFields.id, id), eq(specFields.version, version)))
    .returning({ id: specFields.id });
  return rows.length > 0;
}

export async function deleteSpecFieldIfVersion(id: string, version: number): Promise<boolean> {
  const rows = await getDb()
    .delete(specFields)
    .where(and(eq(specFields.id, id), eq(specFields.version, version)))
    .returning({ id: specFields.id });
  return rows.length > 0;
}

export async function insertOptions(companyId: string, fieldId: string, values: readonly { value: string; position: number }[]) {
  if (!values.length) return [];
  return getDb()
    .insert(specFieldOptions)
    .values(
      values.map((v) => ({
        companyId,
        fieldId,
        value: v.value,
        position: v.position,
      })),
    )
    .returning({ id: specFieldOptions.id, value: specFieldOptions.value });
}

export async function updateOption(id: string, value: string, position: number): Promise<void> {
  await getDb()
    .update(specFieldOptions)
    .set({
      value,
      position,
      version: sql`${specFieldOptions.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(eq(specFieldOptions.id, id));
}

export async function deleteOptions(ids: readonly string[]): Promise<void> {
  if (ids.length)
    await getDb()
      .delete(specFieldOptions)
      .where(inArray(specFieldOptions.id, [...ids]));
}

export async function fieldHasValues(fieldId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: productSpecValues.id })
    .from(productSpecValues)
    .where(eq(productSpecValues.fieldId, fieldId))
    .limit(1);
  return rows.length > 0;
}

// ---- Mẫu nhóm ----

/** Trục chuẩn của các nhóm (theo thứ tự), kèm giá trị khi `withValues`. */
export async function findGroupAxes(groupIds: readonly string[], withValues = false) {
  if (!groupIds.length) return new Map<string, AxisRow[]>();
  const groups = await getDb()
    .select({
      id: productGroups.id,
      axis1: productGroups.axis1AttributeId,
      axis2: productGroups.axis2AttributeId,
    })
    .from(productGroups)
    .where(inArray(productGroups.id, [...groupIds]));
  const attrIds = [...new Set(groups.flatMap((g) => [g.axis1, g.axis2]).filter((x): x is string => x !== null))];
  const attrs = attrIds.length
    ? await getDb()
        .select({
          id: attributes.id,
          name: attributes.name,
          platformKind: attributes.platformKind,
        })
        .from(attributes)
        .where(inArray(attributes.id, attrIds))
    : [];
  const values =
    withValues && attrIds.length
      ? await getDb()
          .select({
            id: attributeValues.id,
            attributeId: attributeValues.attributeId,
            value: attributeValues.value,
          })
          .from(attributeValues)
          .where(inArray(attributeValues.attributeId, attrIds))
          .orderBy(asc(attributeValues.createdAt), asc(attributeValues.id))
      : [];
  const valuesBy = Map.groupBy(values, (v) => v.attributeId);
  const attrBy = new Map(attrs.map((a) => [a.id, a]));
  const result = new Map<string, AxisRow[]>();
  for (const g of groups) {
    result.set(
      g.id,
      [g.axis1, g.axis2]
        .filter((x): x is string => x !== null && attrBy.has(x))
        .map((attributeId) => {
          const a = attrBy.get(attributeId)!;
          return {
            attributeId,
            name: a.name,
            platformKind: a.platformKind,
            values: (valuesBy.get(attributeId) ?? []).map(({ attributeId: _, ...v }) => v),
          };
        }),
    );
  }
  return result;
}

export interface AxisRow {
  attributeId: string;
  name: string;
  platformKind: string | null;
  values: { id: string; value: string }[];
}

/** Thông số của mẫu các nhóm, theo `position`, kèm định nghĩa thông số. */
export function findTemplateFields(groupIds: readonly string[]) {
  if (!groupIds.length) return Promise.resolve([]);
  return getDb()
    .select({
      groupId: groupSpecFields.groupId,
      fieldId: groupSpecFields.fieldId,
      required: groupSpecFields.required,
      position: groupSpecFields.position,
      code: specFields.code,
      name: specFields.name,
      input: specFields.input,
      unit: specFields.unit,
      allowCustom: specFields.allowCustom,
    })
    .from(groupSpecFields)
    .innerJoin(specFields, eq(specFields.id, groupSpecFields.fieldId))
    .where(inArray(groupSpecFields.groupId, [...groupIds]))
    .orderBy(asc(groupSpecFields.position));
}

export async function setGroupAxes(groupId: string, axis1: string | null, axis2: string | null): Promise<void> {
  await getDb().update(productGroups).set({ axis1AttributeId: axis1, axis2AttributeId: axis2 }).where(eq(productGroups.id, groupId));
}

export async function replaceTemplateFields(
  companyId: string,
  groupId: string,
  fields: readonly { fieldId: string; required: boolean }[],
): Promise<void> {
  await getDb().delete(groupSpecFields).where(eq(groupSpecFields.groupId, groupId));
  if (fields.length) {
    await getDb()
      .insert(groupSpecFields)
      .values(
        fields.map((f, position) => ({
          companyId,
          groupId,
          fieldId: f.fieldId,
          required: f.required,
          position,
        })),
      );
  }
}

/** Chép trục chuẩn và mẫu thông số của nhóm nguồn sang nhóm đích (thay mẫu cũ của đích). */
export async function copyTemplate(companyId: string, fromId: string, toId: string): Promise<void> {
  const [from] = await getDb()
    .select({ axis1: productGroups.axis1AttributeId, axis2: productGroups.axis2AttributeId })
    .from(productGroups)
    .where(eq(productGroups.id, fromId));
  await setGroupAxes(toId, from?.axis1 ?? null, from?.axis2 ?? null);
  const fields = await getDb()
    .select({ fieldId: groupSpecFields.fieldId, required: groupSpecFields.required })
    .from(groupSpecFields)
    .where(eq(groupSpecFields.groupId, fromId))
    .orderBy(asc(groupSpecFields.position));
  await replaceTemplateFields(companyId, toId, fields);
}

/** Tăng `version` của nhóm có điều kiện; `null` khi người khác vừa sửa. */
export async function bumpGroupVersion(id: string, version: number): Promise<number | null> {
  const [row] = await getDb()
    .update(productGroups)
    .set({ version: sql`${productGroups.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(productGroups.id, id), eq(productGroups.version, version)))
    .returning({ version: productGroups.version });
  return row?.version ?? null;
}

/** Số nhóm có thuộc tính này làm trục chuẩn (409 `in_use` khi xoá thuộc tính). */
export async function groupsUsingAxis(attributeId: string): Promise<number> {
  const [row] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(productGroups)
    .where(sql`${productGroups.axis1AttributeId} = ${attributeId} or ${productGroups.axis2AttributeId} = ${attributeId}`);
  return row?.n ?? 0;
}

// ---- Giá trị của sản phẩm ----

/** Giá trị thông số của các sản phẩm, một dòng mỗi lựa chọn hoặc một dòng chữ; lựa chọn theo `position`. */
export function findProductSpecValues(productIds: readonly string[]) {
  if (!productIds.length) return Promise.resolve([]);
  return getDb()
    .select({
      productId: productSpecValues.productId,
      fieldId: productSpecValues.fieldId,
      code: specFields.code,
      name: specFields.name,
      input: specFields.input,
      unit: specFields.unit,
      allowCustom: specFields.allowCustom,
      optionId: productSpecValues.optionId,
      optionValue: specFieldOptions.value,
      valueText: productSpecValues.valueText,
    })
    .from(productSpecValues)
    .innerJoin(specFields, eq(specFields.id, productSpecValues.fieldId))
    .leftJoin(specFieldOptions, eq(specFieldOptions.id, productSpecValues.optionId))
    .where(inArray(productSpecValues.productId, [...productIds]))
    .orderBy(asc(specFieldOptions.position), asc(specFieldOptions.id));
}

/** Thay giá trị của một thông số của sản phẩm (xoá rồi chèn). */
export async function replaceProductSpec(
  companyId: string,
  productId: string,
  fieldId: string,
  value: { optionIds: readonly string[] } | { text: string } | null,
): Promise<void> {
  await getDb()
    .delete(productSpecValues)
    .where(and(eq(productSpecValues.productId, productId), eq(productSpecValues.fieldId, fieldId)));
  if (!value) return;
  const rows =
    'text' in value
      ? [{ companyId, productId, fieldId, valueText: value.text }]
      : value.optionIds.map((optionId) => ({
          companyId,
          productId,
          fieldId,
          optionId,
        }));
  if (rows.length) await getDb().insert(productSpecValues).values(rows);
}

/** Thông số đã có giá trị của sản phẩm (cho `fillProductFacts`: chỉ điền thông số trống). */
export async function filledSpecFieldIds(productId: string): Promise<Set<string>> {
  const rows = await getDb()
    .selectDistinct({ fieldId: productSpecValues.fieldId })
    .from(productSpecValues)
    .where(eq(productSpecValues.productId, productId));
  return new Set(rows.map((r) => r.fieldId));
}

/**
 * Thông số `required` của mẫu nhóm hiện tại mà sản phẩm chưa có giá trị (độ hoàn thiện `specs`, Documents/21 §17.1),
 * theo thứ tự mẫu. Một câu cho cả lô.
 */
export async function missingRequiredSpecs(productIds: readonly string[]): Promise<Map<string, string[]>> {
  if (!productIds.length) return new Map();
  const { rows } = await getDb().execute<{ product_id: string; field_id: string }>(sql`
    select p.id as product_id, g.field_id
    from product.products p
    join product.group_spec_fields g on g.group_id = p.group_id and g.required
    where p.id in (${sql.join(
      productIds.map((id) => sql`${id}`),
      sql`, `,
    )})
      and not exists (select 1 from product.product_spec_values v where v.product_id = p.id and v.field_id = g.field_id)
    order by g.position`);
  const result = new Map<string, string[]>();
  for (const r of rows) result.set(r.product_id, [...(result.get(r.product_id) ?? []), r.field_id]);
  return result;
}

/** Thông số theo id (đọc qua RLS), kèm lựa chọn. */
export async function findSpecFieldsByIds(ids: readonly string[]) {
  if (!ids.length) return [];
  const rows = await getDb()
    .select({
      id: specFields.id,
      code: specFields.code,
      name: specFields.name,
      input: specFields.input,
      unit: specFields.unit,
      allowCustom: specFields.allowCustom,
    })
    .from(specFields)
    .where(inArray(specFields.id, [...ids]));
  const options = rows.length ? await findOptions(rows.map((r) => r.id)) : [];
  const byField = Map.groupBy(options, (o) => o.fieldId);
  return rows.map((r) => ({ ...r, options: (byField.get(r.id) ?? []).map((o) => ({ id: o.id, value: o.value })) }));
}

/**
 * Lựa chọn mới gõ ở form sản phẩm (`allowCustom`): thêm cuối danh sách; trùng `lower(value)` với lựa chọn vừa được request
 * khác thêm thì dùng lựa chọn đó. Trả id theo thứ tự `values`.
 */
export async function ensureOptions(companyId: string, fieldId: string, values: readonly string[]): Promise<string[]> {
  if (!values.length) return [];
  const [max] = await getDb()
    .select({ p: sql<number>`coalesce(max(${specFieldOptions.position}), -1)::int` })
    .from(specFieldOptions)
    .where(eq(specFieldOptions.fieldId, fieldId));
  await getDb()
    .insert(specFieldOptions)
    .values(values.map((value, i) => ({ companyId, fieldId, value, position: (max?.p ?? -1) + 1 + i })))
    .onConflictDoNothing();
  const rows = await getDb()
    .select({ id: specFieldOptions.id, value: specFieldOptions.value })
    .from(specFieldOptions)
    .where(eq(specFieldOptions.fieldId, fieldId));
  const byKey = new Map(rows.map((r) => [r.value.toLowerCase(), r.id]));
  return values.map((v) => byKey.get(v.toLowerCase())!);
}

/** Nhóm có thông số trong mẫu, xếp tên, tối đa `limit` (409 `in_use` khi xoá thông số). */
export function groupsUsingField(fieldId: string, limit = 20) {
  return getDb()
    .select({ id: productGroups.id, name: productGroups.name })
    .from(groupSpecFields)
    .innerJoin(productGroups, eq(productGroups.id, groupSpecFields.groupId))
    .where(eq(groupSpecFields.fieldId, fieldId))
    .orderBy(asc(productGroups.name))
    .limit(limit);
}
