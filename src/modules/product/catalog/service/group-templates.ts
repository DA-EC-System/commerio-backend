// Mẫu thông số và trục chuẩn của nhóm hàng (Documents/21 mục 5.5 `GroupTemplate`, 19 §3.2).
import { withCompany } from '../../../../shared/db/client.ts';
import { recordAudit } from '../../../core/index.ts';
import { findGroups } from '../repository/groups.ts';
import {
  bumpGroupVersion,
  findGroupAxes,
  findOptions,
  findSpecFields,
  findTemplateFields,
  replaceTemplateFields,
  setGroupAxes,
} from '../repository/specs.ts';
import { findAttributes } from '../repository/attributes.ts';
import { auditOf, type Caller, invalid, isUuid, notFound, versionConflict } from './errors.ts';

export interface TemplateInput {
  axisAttributeIds: string[];
  fields: { fieldId: string; required: boolean }[];
  version: number;
}

const ENTITY = 'product.product_groups';

async function findGroup(id: string) {
  const [group] = isUuid(id) ? await findGroups(id) : [];
  if (!group) throw notFound('nhóm hàng');
  return group;
}

/** Mẫu của một nhóm: trục (kèm giá trị), thông số theo thứ tự kèm lựa chọn. Chạy trong `withCompany`. */
async function templateOf(groupId: string, version: number) {
  const axes = (await findGroupAxes([groupId], true)).get(groupId) ?? [];
  const fields = await findTemplateFields([groupId]);
  const options = fields.length ? await findOptions(fields.map((f) => f.fieldId)) : [];
  const byField = Map.groupBy(options, (o) => o.fieldId);
  return {
    groupId,
    axes,
    fields: fields.map((f) => ({
      fieldId: f.fieldId,
      code: f.code,
      name: f.name,
      input: f.input,
      unit: f.unit,
      allowCustom: f.allowCustom,
      required: f.required,
      options: (byField.get(f.fieldId) ?? []).map((o) => ({
        id: o.id,
        value: o.value,
      })),
    })),
    version,
  };
}
export type GroupTemplate = Awaited<ReturnType<typeof templateOf>>;

export async function getGroupTemplate(companyId: string, groupId: string): Promise<GroupTemplate> {
  return withCompany(companyId, async () => {
    const group = await findGroup(groupId);
    return templateOf(group.id, group.version);
  });
}

export async function putGroupTemplate(caller: Caller, groupId: string, input: TemplateInput): Promise<GroupTemplate> {
  return withCompany(caller.companyId, async () => {
    const group = await findGroup(groupId);
    if (group.version !== input.version)
      throw versionConflict('Nhóm hàng vừa được người khác sửa', await templateOf(group.id, group.version));
    const errors: Record<string, string> = {};
    // Khoá ngoại bỏ qua RLS: thuộc tính, thông số phải đọc được trong công ty.
    const attrs = new Map((await findAttributes()).map((a) => [a.id, a.name]));
    if (input.axisAttributeIds.some((id) => !attrs.has(id))) errors.axisAttributeIds = 'Có thuộc tính không tồn tại';
    const fields = new Map((await findSpecFields()).map((f) => [f.id, f.name]));
    for (const [i, f] of input.fields.entries()) {
      if (!fields.has(f.fieldId)) errors[`fields.${i}.fieldId`] = 'Không tìm thấy thông số';
    }
    if (Object.keys(errors).length) throw invalid(errors);

    const before = await templateOf(group.id, group.version);
    const [axis1 = null, axis2 = null] = input.axisAttributeIds;
    await setGroupAxes(group.id, axis1, axis2);
    await replaceTemplateFields(caller.companyId, group.id, input.fields);
    const bumped = await bumpGroupVersion(group.id, input.version);
    if (!bumped) {
      const current = await findGroup(group.id);
      throw versionConflict('Nhóm hàng vừa được người khác sửa', await templateOf(current.id, current.version));
    }
    const describe = (t: { axes: { name: string }[]; fields: { name: string; required: boolean }[] }) => ({
      axes: t.axes.map((a) => a.name),
      fields: t.fields.map((f) => (f.required ? `${f.name} (bắt buộc)` : f.name)),
    });
    await recordAudit({
      ...auditOf(caller, 'update', ENTITY, group.id),
      label: group.name,
      operation: 'template',
      before: describe(before),
      after: describe({
        axes: input.axisAttributeIds.map((id) => ({ name: attrs.get(id)! })),
        fields: input.fields.map((f) => ({
          name: fields.get(f.fieldId)!,
          required: f.required,
        })),
      }),
    });
    return templateOf(group.id, bumped);
  });
}
