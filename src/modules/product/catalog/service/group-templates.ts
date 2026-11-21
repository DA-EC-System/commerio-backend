// Mẫu thông số và trục chuẩn của nhóm hàng (Documents/21 mục 5.5 `GroupTemplate`, 5.6 hai tầng; 19 §3.2). Nhóm nền tảng:
// trục và dòng chuẩn do nền tảng đặt, công ty chỉ thêm dòng của mình sau dòng chuẩn; `version` là của `company_group_settings`.
import { withCompany } from '../../../../shared/db/client.ts';
import { recordAudit } from '../../../core/index.ts';
import { findGroups, upsertGroupSettingsIfVersion } from '../repository/groups.ts';
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
import { auditOf, type Caller, invalid, isUuid, notFound, scopeOf, versionConflict } from './errors.ts';

export interface TemplateInput {
  /** Nhóm của công ty: bỏ trống là giữ trục đang có. Nhóm nền tảng: gửi thì 422. */
  axisAttributeIds?: string[] | undefined;
  fields: { fieldId: string; required: boolean }[];
  version: number;
}

const ENTITY = 'product.product_groups';
const SETTINGS_ENTITY = 'product.company_group_settings';

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
    axes: axes.map(({ companyId, values, ...a }) => ({
      ...a,
      scope: scopeOf(companyId),
      values: values.map((v) => ({ id: v.id, value: v.value, scope: scopeOf(v.companyId) })),
    })),
    fields: fields.map((f) => ({
      fieldId: f.fieldId,
      scope: scopeOf(f.companyId),
      code: f.code,
      name: f.name,
      input: f.input,
      unit: f.unit,
      allowCustom: f.allowCustom,
      required: f.required,
      options: (byField.get(f.fieldId) ?? []).map((o) => ({
        id: o.id,
        value: o.value,
        scope: scopeOf(o.companyId),
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
    const platformGroup = group.companyId === null;
    // Thứ tự lỗi Documents/21 mục 5.6: 422 trước 409.
    const errors: Record<string, string> = {};
    if (platformGroup && input.axisAttributeIds !== undefined) errors.axisAttributeIds = 'Trục của nhóm chuẩn do nền tảng đặt';
    // Khoá ngoại bỏ qua RLS: thuộc tính, thông số phải đọc được trong công ty (dòng nền tảng hoặc của công ty).
    const attrs = new Map((await findAttributes()).map((a) => [a.id, a.name]));
    if (!platformGroup && input.axisAttributeIds?.some((id) => !attrs.has(id))) errors.axisAttributeIds = 'Có thuộc tính không tồn tại';
    const fields = new Map((await findSpecFields()).map((f) => [f.id, f.name]));
    const standard = platformGroup
      ? new Set((await findTemplateFields([group.id])).filter((f) => f.companyId === null).map((f) => f.fieldId))
      : new Set<string>();
    for (const [i, f] of input.fields.entries()) {
      if (!fields.has(f.fieldId)) errors[`fields.${i}.fieldId`] = 'Không tìm thấy thông số';
      else if (standard.has(f.fieldId)) errors[`fields.${i}.fieldId`] = 'Đã có trong mẫu chuẩn';
    }
    if (Object.keys(errors).length) throw invalid(errors);
    if (group.version !== input.version)
      throw versionConflict('Nhóm hàng vừa được người khác sửa', await templateOf(group.id, group.version));

    const before = await templateOf(group.id, group.version);
    const axisIds = platformGroup ? before.axes.map((a) => a.attributeId) : (input.axisAttributeIds ?? before.axes.map((a) => a.attributeId));
    if (!platformGroup) {
      const [axis1 = null, axis2 = null] = axisIds;
      await setGroupAxes(group.id, axis1, axis2);
    }
    await replaceTemplateFields(caller.companyId, group.id, input.fields);
    const written = platformGroup
      ? await upsertGroupSettingsIfVersion(caller.companyId, group.id, input.version, {})
      : (await bumpGroupVersion(group.id, input.version)) !== null;
    const current = await findGroup(group.id);
    if (!written) throw versionConflict('Nhóm hàng vừa được người khác sửa', await templateOf(current.id, current.version));
    const describe = (t: { axes: { name: string }[]; fields: { name: string; required: boolean }[] }) => ({
      axes: t.axes.map((a) => a.name),
      fields: t.fields.map((f) => (f.required ? `${f.name} (bắt buộc)` : f.name)),
    });
    // Nhóm nền tảng: nhật ký chỉ nêu phần của công ty.
    const own = (t: GroupTemplate) => (platformGroup ? { ...t, axes: [], fields: t.fields.filter((f) => f.scope === 'company') } : t);
    await recordAudit({
      ...auditOf(caller, 'update', platformGroup ? SETTINGS_ENTITY : ENTITY, group.id),
      label: group.name,
      operation: 'template',
      before: describe(own(before)),
      after: describe({
        axes: platformGroup ? [] : axisIds.map((id) => ({ name: attrs.get(id) ?? '' })),
        fields: input.fields.map((f) => ({
          name: fields.get(f.fieldId)!,
          required: f.required,
        })),
      }),
    });
    return templateOf(group.id, current.version);
  });
}
