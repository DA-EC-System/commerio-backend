// Thuộc tính biến thể ghép (commerio-backend#568, Documents/21 §18.8.3). Hàm thuần.
// Nhiều trục của sản phẩm trỏ cùng một đích trong `axisMap` thì lúc đẩy gộp thành một thuộc tính biến thể của sàn; giá trị nối
// nhãn các trục theo thứ tự trục của sản phẩm. Catalog không đổi; mỗi sàn ghép riêng theo spec của sàn đó.
import { CUSTOM_AXIS, type PlatformAttribute, type VariantCapabilities } from './product-spec.ts';

/** Dấu nối giá trị của các trục ghép, ví dụ "Đỏ - S" (Thành chốt 24/11/2026). */
export const COMBINE_SEPARATOR = ' - ';

/** Kiểu nhập nhận chữ. Kiểu số, ngày dù `allowCustom` (Lazada `numeric`, `date`) không nhận chữ ghép "Đỏ - S". */
const TEXT_INPUTS: ReadonlySet<PlatformAttribute['input']> = new Set(['select', 'multiselect', 'text']);

/** Sales attribute nhận được giá trị ghép: nhận chữ ngoài lựa chọn và kiểu nhập là chữ. */
export const combinable = (attr: Pick<PlatformAttribute, 'kind' | 'allowCustom' | 'input'>): boolean =>
  attr.kind === 'sales' && attr.allowCustom && TEXT_INPUTS.has(attr.input);

/**
 * Đích trong `axisMap` có ghép được không: `__custom` khi adapter nhận tên trục tự đặt (`caps` null coi như nhận, cùng luật
 * `specMissing`); mã sales attribute thì theo `combinable`. `leaf` null (chưa lấy attribute) thì chưa biết: cho qua, việc nền
 * lấy rồi kiểm lại như `specMissing`.
 */
export function targetCombinable(
  target: string,
  leaf: readonly PlatformAttribute[] | null,
  caps: Pick<VariantCapabilities, 'customAxisName'> | null,
): boolean {
  if (target === CUSTOM_AXIS) return caps === null || caps.customAxisName;
  if (leaf === null) return true;
  const attr = leaf.find((a) => a.code === target);
  return attr !== undefined && combinable(attr);
}

/**
 * Đích BE đề xuất để ghép khi sản phẩm nhiều trục hơn `maxAxes`: sale prop bắt buộc ghép được, rồi sale prop ghép được đầu
 * tiên, rồi `__custom` nếu adapter nhận tên tự đặt; không có thì null (leaf không ghép được, vd chỉ có sale prop kiểu số).
 */
export function combineTarget(
  leaf: readonly PlatformAttribute[] | null,
  caps: Pick<VariantCapabilities, 'customAxisName'> | null,
): string | null {
  if (leaf === null) return null;
  const ok = leaf.filter(combinable);
  const pick = ok.find((a) => a.required) ?? ok[0];
  if (pick) return pick.code;
  return caps?.customAxisName ? CUSTOM_AXIS : null;
}

/** Một thuộc tính biến thể của sàn và các trục sản phẩm đổ vào nó, theo thứ tự trục của sản phẩm. */
export interface AxisGroup {
  target: string;
  attributeIds: string[];
}

/** Gom trục theo đích; thứ tự nhóm theo trục đầu tiên của nhóm. Trục chưa ánh xạ bị bỏ qua (`axis_unmapped` báo riêng). */
export function axisGroups(axisMap: Readonly<Record<string, string>>, attributeIds: readonly string[]): AxisGroup[] {
  const groups: AxisGroup[] = [];
  for (const id of attributeIds) {
    const target = axisMap[id];
    if (!target) continue;
    const g = groups.find((x) => x.target === target);
    if (g) g.attributeIds.push(id);
    else groups.push({ target, attributeIds: [id] });
  }
  return groups;
}

/** Nhãn giá trị ghép từ nhãn các trục theo thứ tự trục. */
export const joinValues = (labels: readonly string[]): string => labels.join(COMBINE_SEPARATOR);
