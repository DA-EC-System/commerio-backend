import { sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { DEFAULT_ATTRIBUTES, DEFAULT_GROUPS } from '../domain/defaults.ts';
import { DEFAULT_GROUP_TEMPLATES, DEFAULT_SPEC_FIELDS } from '../domain/spec-defaults.ts';
import {
  attributes,
  attributeValues,
  companyProductSettings,
  groupSpecFields,
  type PlatformKind,
  productGroups,
  specFieldOptions,
  specFields,
} from './schema.ts';

// Chạy trong giao dịch đăng ký (role chủ bảng, chưa có `app.company_id`): ghi `company_id` tường minh.
// `created_at` tăng dần theo thứ tự khai để danh sách hiện đúng thứ tự (sắp theo `created_at`, `id`).
const at = (i: number) => sql`now() + ${i} * interval '1 millisecond'`;

export async function insertCompanyDefaults(companyId: string): Promise<void> {
  const db = getDb();
  await db.insert(companyProductSettings).values({ companyId });
  const groups = await db
    .insert(productGroups)
    .values(DEFAULT_GROUPS.map((name, i) => ({ companyId, name, createdAt: at(i) })))
    .returning({ id: productGroups.id, name: productGroups.name });
  const attrByKind = new Map<PlatformKind, string>();
  for (const [i, attr] of DEFAULT_ATTRIBUTES.entries()) {
    const [row] = await db
      .insert(attributes)
      .values({
        companyId,
        name: attr.name,
        platformKind: attr.kind,
        createdAt: at(i),
      })
      .returning({ id: attributes.id });
    attrByKind.set(attr.kind, row!.id);
    await db.insert(attributeValues).values(
      attr.values.map(([value, code], j) => ({
        companyId,
        attributeId: row!.id,
        value,
        code,
        createdAt: at(j),
      })),
    );
  }

  const fields = await db
    .insert(specFields)
    .values(
      DEFAULT_SPEC_FIELDS.map((f, i) => ({
        companyId,
        code: f.code,
        name: f.name,
        input: f.input,
        unit: f.unit ?? null,
        allowCustom: f.allowCustom,
        createdAt: at(i),
      })),
    )
    .returning({ id: specFields.id, code: specFields.code });
  const fieldByCode = new Map(fields.map((f) => [f.code, f.id]));
  const options = DEFAULT_SPEC_FIELDS.flatMap((f) =>
    (f.options ?? []).map((value, position) => ({
      companyId,
      fieldId: fieldByCode.get(f.code)!,
      value,
      position,
    })),
  );
  if (options.length) await db.insert(specFieldOptions).values(options);

  const groupByName = new Map(groups.map((g) => [g.name, g.id]));
  const templateRows = [];
  for (const tpl of DEFAULT_GROUP_TEMPLATES) {
    const groupId = groupByName.get(tpl.group)!;
    const [axis1, axis2] = tpl.axes.map((k) => attrByKind.get(k) ?? null);
    await db
      .update(productGroups)
      .set({ axis1AttributeId: axis1 ?? null, axis2AttributeId: axis2 ?? null })
      .where(sql`${productGroups.id} = ${groupId}`);
    templateRows.push(
      ...tpl.fields.map(([code, required], position) => ({
        companyId,
        groupId,
        fieldId: fieldByCode.get(code)!,
        required,
        position,
      })),
    );
  }
  await db.insert(groupSpecFields).values(templateRows);
}
