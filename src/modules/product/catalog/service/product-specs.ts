// Giá trị thông số của sản phẩm cha (Documents/21 mục 5.5 `SpecInput`, `ProductDetail.specs`; 11.3 `getProductSpecs`,
// `fillProductFacts`). Mọi hàm chạy trong `withCompany` của bên gọi.
import { planSpecValue, type SpecInputKind, type SpecValuePlan } from '../domain/specs.ts';
import {
  ensureOptions,
  filledSpecFieldIds,
  findOptions,
  findProductSpecValues,
  findSpecFieldsByIds,
  findTemplateFields,
  missingRequiredSpecs,
  replaceProductSpec,
} from '../repository/specs.ts';
import { productGroupIds } from '../repository/products.ts';
import { isUuid } from './errors.ts';

export interface SpecValueInput {
  fieldId: string;
  optionIds?: string[] | undefined;
  newValues?: string[] | undefined;
  value?: string | undefined;
}

type ValueRow = Awaited<ReturnType<typeof findProductSpecValues>>[number];

interface StoredSpec {
  fieldId: string;
  code: string;
  name: string;
  input: SpecInputKind;
  unit: string | null;
  allowCustom: boolean;
  selected: { id: string; value: string }[];
  value: string | null;
}

/** Gom dòng giá trị theo sản phẩm, rồi theo thông số (lựa chọn đã theo `position`). */
function groupValues(rows: readonly ValueRow[]): Map<string, Map<string, StoredSpec>> {
  const result = new Map<string, Map<string, StoredSpec>>();
  for (const r of rows) {
    const byField = result.get(r.productId) ?? new Map<string, StoredSpec>();
    result.set(r.productId, byField);
    const spec = byField.get(r.fieldId) ?? {
      fieldId: r.fieldId,
      code: r.code,
      name: r.name,
      input: r.input,
      unit: r.unit,
      allowCustom: r.allowCustom,
      selected: [],
      value: null,
    };
    byField.set(r.fieldId, spec);
    if (r.optionId) spec.selected.push({ id: r.optionId, value: r.optionValue! });
    else spec.value = r.valueText;
  }
  return result;
}

/** Chữ đọc được cho nhật ký: lựa chọn nối dấu phẩy, hoặc chữ. */
const display = (s: StoredSpec | undefined) => (s ? (s.value ?? s.selected.map((o) => o.value).join(', ')) : null);

/**
 * Kiểm `specs` của `POST`/`PUT /products` (Documents/21 mục 5.5): lỗi theo ô `specs.<i>`; thông số ngoài mẫu nhóm vẫn
 * nhận. Không ghi gì. Trả kế hoạch ghi cho `applySpecs`.
 */
export async function checkSpecs(specs: readonly SpecValueInput[]) {
  const ids = [...new Set(specs.map((s) => s.fieldId).filter(isUuid))];
  const fields = new Map((await findSpecFieldsByIds(ids)).map((f) => [f.id, f]));
  const errors: Record<string, string> = {};
  const plans: { fieldId: string; code: string; plan: SpecValuePlan }[] = [];
  const seen = new Set<string>();
  for (const [i, s] of specs.entries()) {
    const field = fields.get(s.fieldId);
    if (!field) {
      errors[`specs.${i}`] = 'Không tìm thấy thông số';
      continue;
    }
    if (seen.has(s.fieldId)) {
      errors[`specs.${i}`] = 'Thông số gửi hai lần';
      continue;
    }
    seen.add(s.fieldId);
    const plan = planSpecValue({ input: field.input, allowCustom: field.allowCustom, options: new Map(field.options.map((o) => [o.id, o.value])) }, s);
    if ('error' in plan) errors[`specs.${i}`] = plan.error;
    else plans.push({ fieldId: field.id, code: field.code, plan });
  }
  return { errors, plans };
}
export type SpecPlans = Awaited<ReturnType<typeof checkSpecs>>['plans'];

/** Ghi kế hoạch đã kiểm; trả giá trị trước, sau theo `code` cho nhật ký (chỉ thông số đổi). */
export async function applySpecs(companyId: string, productId: string, plans: SpecPlans) {
  if (!plans.length) return { before: {}, after: {} };
  const current = groupValues(await findProductSpecValues([productId])).get(productId) ?? new Map<string, StoredSpec>();
  const before: Record<string, string | null> = {};
  const after: Record<string, string | null> = {};
  for (const { fieldId, code, plan } of plans) {
    const old = display(current.get(fieldId));
    if (plan.kind === 'clear') {
      await replaceProductSpec(companyId, productId, fieldId, null);
    } else if (plan.kind === 'text') {
      await replaceProductSpec(companyId, productId, fieldId, { text: plan.text });
    } else {
      const fresh = await ensureOptions(companyId, fieldId, plan.newValues);
      await replaceProductSpec(companyId, productId, fieldId, { optionIds: [...new Set([...plan.optionIds, ...fresh])] });
    }
    const now = display(groupValues(await findProductSpecValues([productId])).get(productId)?.get(fieldId));
    if (old !== now) {
      before[code] = old;
      after[code] = now;
    }
  }
  return { before, after };
}

/**
 * `ProductDetail.specs` và `missingSpecFieldIds` (Documents/21 mục 5.5): thông số của mẫu nhóm hiện tại theo thứ tự (kể cả
 * trống), rồi thông số ngoài mẫu đang có giá trị (theo tên). `choices` là mọi lựa chọn của thông số.
 */
export async function productSpecsView(productId: string, groupId: string) {
  const template = await findTemplateFields([groupId]);
  const values = groupValues(await findProductSpecValues([productId])).get(productId) ?? new Map<string, StoredSpec>();
  const inTemplate = new Set(template.map((t) => t.fieldId));
  const extra = [...values.values()].filter((v) => !inTemplate.has(v.fieldId)).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  const fieldIds = [...inTemplate, ...extra.map((e) => e.fieldId)];
  const options = Map.groupBy(fieldIds.length ? await findOptions(fieldIds) : [], (o) => o.fieldId);
  const choices = (fieldId: string) => (options.get(fieldId) ?? []).map((o) => ({ id: o.id, value: o.value }));
  const specs = [
    ...template.map((t) => {
      const v = values.get(t.fieldId);
      return {
        fieldId: t.fieldId,
        code: t.code,
        name: t.name,
        input: t.input,
        unit: t.unit,
        allowCustom: t.allowCustom,
        required: t.required,
        inTemplate: true,
        selected: v?.selected ?? [],
        choices: choices(t.fieldId),
        value: v?.value ?? null,
      };
    }),
    ...extra.map((v) => ({
      fieldId: v.fieldId,
      code: v.code,
      name: v.name,
      input: v.input,
      unit: v.unit,
      allowCustom: v.allowCustom,
      required: false,
      inTemplate: false,
      selected: v.selected,
      choices: choices(v.fieldId),
      value: v.value,
    })),
  ];
  const missingSpecFieldIds = (await missingRequiredSpecs([productId])).get(productId) ?? [];
  return { specs, missingSpecFieldIds };
}

/**
 * Cổng `getProductSpecs(productIds)` cho channel (Documents/21 mục 11.3): giá trị thông số của sản phẩm cha, kể cả ngoài
 * mẫu. `values` xếp thông số trong mẫu theo `position`, rồi ngoài mẫu theo `code` (`position` null). Sản phẩm không thấy
 * (RLS, sai id) thì vắng mặt.
 */
export async function getProductSpecs(productIds: readonly string[]) {
  const ids = [...new Set(productIds.filter(isUuid))];
  const result = new Map<
    string,
    {
      groupId: string;
      values: {
        fieldId: string;
        code: string;
        input: SpecInputKind;
        unit: string | null;
        allowCustom: boolean;
        optionIds: string[];
        optionLabels: string[];
        value: string | null;
        position: number | null;
      }[];
    }
  >();
  if (!ids.length) return result;
  const groups = await productGroupIds(ids);
  const templates = Map.groupBy(await findTemplateFields([...new Set(groups.values())]), (t) => t.groupId);
  const values = groupValues(await findProductSpecValues([...groups.keys()]));
  for (const [productId, groupId] of groups) {
    const position = new Map((templates.get(groupId) ?? []).map((t) => [t.fieldId, t.position]));
    const list = [...(values.get(productId)?.values() ?? [])]
      .map((v) => ({
        fieldId: v.fieldId,
        code: v.code,
        input: v.input,
        unit: v.unit,
        allowCustom: v.allowCustom,
        optionIds: v.selected.map((o) => o.id),
        optionLabels: v.selected.map((o) => o.value),
        value: v.value,
        position: position.get(v.fieldId) ?? null,
      }))
      .sort((a, b) =>
        a.position !== null && b.position !== null
          ? a.position - b.position
          : a.position !== null
            ? -1
            : b.position !== null
              ? 1
              : a.code.localeCompare(b.code),
      );
    result.set(productId, { groupId, values: list });
  }
  return result;
}

/**
 * Phần `specs` của `fillProductFacts` (chiều ngược khi ghép SKU, Documents/21 mục 18.8.2): chỉ ghi thông số đang trống;
 * giá trị không hợp luật (lựa chọn lạ, số sai) thì bỏ, không lỗi. Không tạo lựa chọn mới. Trả `specs.<code>` đã ghi.
 */
export async function fillEmptySpecs(
  companyId: string,
  productId: string,
  specs: readonly { fieldId: string; optionIds?: string[] | undefined; value?: string | undefined }[],
): Promise<{ filled: string[]; after: Record<string, string | null> }> {
  const filledBefore = await filledSpecFieldIds(productId);
  const candidates = specs.filter((s) => isUuid(s.fieldId) && !filledBefore.has(s.fieldId)).map((s) => ({ ...s, newValues: undefined }));
  const { plans } = await checkSpecs(candidates);
  const writes = plans.filter((p) => p.plan.kind !== 'clear');
  const { after } = await applySpecs(companyId, productId, writes);
  return { filled: Object.keys(after).map((code) => `specs.${code}`), after };
}
