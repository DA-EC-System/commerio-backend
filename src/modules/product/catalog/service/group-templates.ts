// Mẫu thông số và trục chuẩn của nhóm hàng (Documents/21 mục 5.5 `GroupTemplate`, 5.6 hai tầng; 19 §3.2). Nhóm nền tảng:
// trục và dòng chuẩn do nền tảng đặt, công ty chỉ thêm dòng của mình sau dòng chuẩn; `version` là của `company_group_settings`.
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import type { SpecInputKind } from '../domain/specs.ts';
import { recordAudit } from '../../../core/index.ts';
import { findGroups, upsertGroupSettingsIfVersion } from '../repository/groups.ts';
import {
  bumpGroupVersion,
  findAllowedAttributes,
  findGroupAxes,
  findOptions,
  findSpecFields,
  findTemplateFields,
  replaceAllowedAttributes,
  replaceTemplateFields,
  setGroupAxes,
} from '../repository/specs.ts';
import { findAttributes } from '../repository/attributes.ts';
import { auditOf, type Caller, invalid, isUuid, notFound, scopeOf, versionConflict } from './errors.ts';
import { createSpecField } from './spec-fields.ts';

export interface TemplateInput {
  /** Nhóm của công ty: bỏ trống là giữ trục đang có. Nhóm nền tảng: gửi thì 422. */
  axisAttributeIds?: string[] | undefined;
  fields: { fieldId: string; required: boolean }[];
  /** Thuộc tính biến thể được phép (21 mục 5.7); bỏ trống là giữ. Nhóm nền tảng: chỉ phần của công ty. */
  allowedAttributeIds?: string[] | undefined;
  version: number;
}

const ENTITY = 'product.product_groups';
const SETTINGS_ENTITY = 'product.company_group_settings';

async function findGroup(id: string) {
  const [group] = isUuid(id) ? await findGroups(id) : [];
  if (!group) throw notFound('nhóm hàng');
  return group;
}

/**
 * Danh sách thuộc tính biến thể được phép của nhóm (21 mục 5.7): trục chuẩn theo thứ tự, rồi dòng nền tảng theo `position`,
 * rồi dòng công ty. Chạy trong `withCompany` (RLS chỉ cho thấy dòng công ty của công ty đang chọn).
 */
async function allowedOf(groupId: string, axes: readonly { attributeId: string; name: string; platformKind: string | null; companyId: string | null }[]) {
  const rows = await findAllowedAttributes([groupId]);
  const axisIds = new Set(axes.map((a) => a.attributeId));
  return [
    ...axes.map((a) => ({ attributeId: a.attributeId, name: a.name, platformKind: a.platformKind, scope: scopeOf(rows.find((r) => r.attributeId === a.attributeId)?.companyId ?? a.companyId), isAxis: true })),
    ...rows
      .filter((r) => !axisIds.has(r.attributeId))
      .map((r) => ({ attributeId: r.attributeId, name: r.name, platformKind: r.platformKind, scope: scopeOf(r.companyId), isAxis: false })),
  ];
}

/**
 * Id thuộc tính được phép của nhóm theo thứ tự của `allowedAttributes`; `GET /attributes?groupId=` (21 mục 5.7). Nhóm
 * không có hoặc của công ty khác: 404. Chạy trong `withCompany`.
 */
export async function allowedAttributeIds(groupId: string): Promise<string[]> {
  const group = await findGroup(groupId);
  const axes = (await findGroupAxes([group.id])).get(group.id) ?? [];
  return (await allowedOf(group.id, axes)).map((a) => a.attributeId);
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
    allowedAttributes: await allowedOf(groupId, axes),
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
    // Danh sách được phép (21 mục 5.7): nhóm nền tảng chỉ nhận phần công ty, không trùng dòng nền tảng.
    const allowedStandard = platformGroup
      ? new Set((await findAllowedAttributes([group.id])).filter((a) => a.companyId === null).map((a) => a.attributeId))
      : new Set<string>();
    for (const [i, id] of (input.allowedAttributeIds ?? []).entries()) {
      if (!attrs.has(id)) errors[`allowedAttributeIds.${i}`] = 'Không tìm thấy thuộc tính';
      else if (allowedStandard.has(id)) errors[`allowedAttributeIds.${i}`] = 'Đã có trong danh sách chuẩn';
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
    // Nhóm của công ty: trục luôn nằm trong danh sách (tự thêm vào đầu), kể cả khi chỉ đổi trục.
    const ownAllowed = input.allowedAttributeIds ?? before.allowedAttributes.filter((a) => a.scope === 'company').map((a) => a.attributeId);
    const nextAllowed = platformGroup ? ownAllowed : [...new Set([...axisIds, ...ownAllowed])];
    await replaceAllowedAttributes(caller.companyId, group.id, nextAllowed);
    const written = platformGroup
      ? await upsertGroupSettingsIfVersion(caller.companyId, group.id, input.version, {})
      : (await bumpGroupVersion(group.id, input.version)) !== null;
    const current = await findGroup(group.id);
    if (!written) throw versionConflict('Nhóm hàng vừa được người khác sửa', await templateOf(current.id, current.version));
    const describe = (t: { axes: { name: string }[]; fields: { name: string; required: boolean }[]; allowed: { name: string }[] }) => ({
      axes: t.axes.map((a) => a.name),
      fields: t.fields.map((f) => (f.required ? `${f.name} (bắt buộc)` : f.name)),
      allowedAttributes: t.allowed.map((a) => a.name),
    });
    // Nhóm nền tảng: nhật ký chỉ nêu phần của công ty.
    const own = (t: GroupTemplate) =>
      platformGroup
        ? { axes: [], fields: t.fields.filter((f) => f.scope === 'company'), allowed: t.allowedAttributes.filter((a) => a.scope === 'company') }
        : { ...t, allowed: t.allowedAttributes };
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
        allowed: nextAllowed.map((id) => ({ name: attrs.get(id) ?? '' })),
      }),
    });
    return templateOf(group.id, current.version);
  });
}

export interface TemplateFieldInput {
  /** `fieldId` chọn thông số có sẵn; không có thì các trường còn lại tạo thông số mới của công ty (Zod đã ép đủ). */
  field: {
    fieldId?: string | undefined;
    name?: string | undefined;
    input?: SpecInputKind | undefined;
    unit?: string | null | undefined;
    allowCustom?: boolean | undefined;
    options?: { value: string }[] | undefined;
  };
  required: boolean;
  version: number;
}

/** Lỗi theo ô của `createSpecField` đổi khoá sang `field.<ô>` cho khớp đường dẫn Zod của body. */
function underField(err: unknown): never {
  const errors = err instanceof AppError ? (err.extensions?.errors as Record<string, string> | undefined) : undefined;
  if (!errors || !(err instanceof AppError)) throw err;
  throw new AppError(err.status, err.code, err.message, {
    ...err.extensions,
    errors: Object.fromEntries(Object.entries(errors).map(([k, v]) => [`field.${k}`, v])),
  });
}

/**
 * Thêm một thông số vào cuối mẫu của nhóm (Documents/21 mục 5.6 `POST /groups/:id/template/fields`): chọn thông số có
 * sẵn hoặc tạo thông số mới (luật như `POST /spec-fields`) rồi gắn, **một giao dịch**: tạo xong mà gắn lỗi (sai `version`)
 * thì thông số mới cũng không còn. Nhóm nền tảng: dòng thêm là dòng của công ty. Ghi qua `putGroupTemplate` nên luật
 * `version`, nhật ký `template` giống `PUT`.
 */
export async function addTemplateField(caller: Caller, groupId: string, input: TemplateFieldInput): Promise<GroupTemplate> {
  return withCompany(caller.companyId, async () => {
    const group = await findGroup(groupId);
    const current = await findTemplateFields([group.id]);
    const { fieldId: chosen, ...spec } = input.field;
    let fieldId: string;
    if (chosen !== undefined) {
      // Khoá ngoại bỏ qua RLS: thông số phải đọc được trong công ty (dòng nền tảng hoặc của công ty).
      const [known] = isUuid(chosen) ? await findSpecFields(chosen) : [];
      if (!known) throw invalid({ 'field.fieldId': 'Không tìm thấy thông số' });
      if (current.some((f) => f.fieldId === chosen)) throw invalid({ 'field.fieldId': 'Đã có trong mẫu' });
      fieldId = chosen;
    } else {
      const created = await createSpecField(caller, {
        name: spec.name!,
        input: spec.input!,
        unit: spec.unit,
        allowCustom: spec.allowCustom!,
        options: spec.options,
      }).catch(underField);
      fieldId = created.id;
    }
    // Dòng của công ty theo thứ tự đang có (RLS chỉ cho thấy dòng công ty đang chọn), thêm dòng mới ở cuối.
    const own = current.filter((f) => f.companyId !== null).map((f) => ({ fieldId: f.fieldId, required: f.required }));
    return putGroupTemplate(caller, group.id, { fields: [...own, { fieldId, required: input.required }], version: input.version });
  });
}
