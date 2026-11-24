// Thuộc tính biến thể ghép (commerio-backend#568, Documents/21 §18.8.3). Hàm thuần.
// Nhiều trục của sản phẩm trỏ cùng một đích trong `axisMap` thì lúc đẩy gộp thành một thuộc tính biến thể của sàn; giá trị nối
// nhãn các trục theo thứ tự trục của sản phẩm. Catalog không đổi; mỗi sàn ghép riêng theo spec của sàn đó.
// Không import `product-spec.ts` (file đó gọi các hàm ở đây): dùng kiểu cấu trúc tối thiểu.

/** Phần của `PlatformAttribute` cần để xét ghép. */
export interface CombineAttr {
  code: string;
  kind: string;
  input: string;
  allowCustom: boolean;
  required: boolean;
}

/** Trục phân loại tự đặt, không ánh xạ sang sales attribute nào của sàn. */
export const CUSTOM_AXIS = '__custom';

/** Dấu nối giá trị của các trục ghép, ví dụ "Đỏ - S" (Thành chốt 24/11/2026). */
export const COMBINE_SEPARATOR = ' - ';

/** Kiểu nhập nhận chữ. Kiểu số, ngày dù `allowCustom` (Lazada `numeric`, `date`) không nhận chữ ghép "Đỏ - S". */
const TEXT_INPUTS: ReadonlySet<string> = new Set(['select', 'multiselect', 'text']);

/** Sales attribute nhận được giá trị ghép: nhận chữ ngoài lựa chọn và kiểu nhập là chữ. */
export const combinable = (attr: Pick<CombineAttr, 'kind' | 'allowCustom' | 'input'>): boolean =>
  attr.kind === 'sales' && attr.allowCustom && TEXT_INPUTS.has(attr.input);

/**
 * Đích trong `axisMap` có ghép được không. `__custom` không bao giờ là đích ghép: mỗi trục `__custom` là một thuộc tính biến thể
 * tên tự đặt riêng (TikTok), gom lại sẽ đổi sản phẩm đang bán. Mã sales attribute thì theo `combinable`; `leaf` null (chưa lấy
 * attribute) thì chưa biết: cho qua, việc nền lấy rồi kiểm lại như `specMissing`.
 */
export function targetCombinable(target: string, leaf: readonly CombineAttr[] | null): boolean {
  if (target === CUSTOM_AXIS) return false;
  if (leaf === null) return true;
  const attr = leaf.find((a) => a.code === target);
  return attr !== undefined && combinable(attr);
}

/**
 * Đích BE đề xuất để ghép khi sản phẩm nhiều trục hơn `maxAxes`: sale prop bắt buộc ghép được, rồi sale prop ghép được đầu
 * tiên; không có thì null (leaf không ghép được, vd chỉ có sale prop kiểu số). Không đề xuất `__custom` (xem `targetCombinable`).
 */
export function combineTarget(leaf: readonly CombineAttr[] | null): string | null {
  if (leaf === null) return null;
  const ok = leaf.filter(combinable);
  return (ok.find((a) => a.required) ?? ok[0])?.code ?? null;
}

/** Một thuộc tính biến thể của sàn và các trục sản phẩm đổ vào nó, theo thứ tự trục của sản phẩm. */
export interface AxisGroup {
  target: string;
  attributeIds: string[];
}

/**
 * Gom trục theo đích; thứ tự nhóm theo trục đầu tiên của nhóm. Mỗi trục `__custom` là một nhóm riêng (không ghép). Trục chưa
 * ánh xạ bị bỏ qua (`axis_unmapped` báo riêng).
 */
export function axisGroups(axisMap: Readonly<Record<string, string>>, attributeIds: readonly string[]): AxisGroup[] {
  const groups: AxisGroup[] = [];
  for (const id of attributeIds) {
    const target = axisMap[id];
    if (!target) continue;
    const g = target === CUSTOM_AXIS ? undefined : groups.find((x) => x.target === target);
    if (g) g.attributeIds.push(id);
    else groups.push({ target, attributeIds: [id] });
  }
  return groups;
}

/** Nhãn giá trị ghép từ nhãn các trục theo thứ tự trục. */
export const joinValues = (labels: readonly string[]): string => labels.join(COMBINE_SEPARATOR);
