// Gom các SKU của một sản phẩm cha thành một sản phẩm sàn nhiều phân loại (#295, Documents/21 §18.8.3–18.8.4). Hàm thuần.
import { axisGroups, joinValues } from './axis-combine.ts';
import { type AttributeOption, CUSTOM_AXIS, type PlatformAttribute } from './product-spec.ts';

export interface GroupVariant {
  id: string;
  /** Giá trị thuộc tính theo `position` của catalog. `valueId` để tìm trục gắn ảnh. */
  attributes: readonly { attributeId: string; attributeName: string; value: string; valueId?: string }[];
  /** Ảnh phân loại của SKU theo giá trị ở thuộc tính gắn ảnh (catalog #340); `url` rỗng coi như không có. */
  image?: { attributeValueId: string; url: string } | null;
}

export interface GroupAxis {
  /** Mã sale prop của leaf; null là trục tự đặt tên (`axisMap` = `__custom`). */
  code: string | null;
  name: string;
  /** `imageUrl`: link ảnh catalog của giá trị (chưa nằm trên sàn); bên gọi tải lên rồi điền `imageUri`. */
  values: { optionId: string | null; label: string; imageUrl?: string }[];
}

export type VariantGroup =
  | { ok: true; axes: GroupAxis[]; valuesOf: Map<string, string[]> }
  | { ok: false; code: 'axis_shape' | 'axis_unmapped'; message: string };

const norm = (s: string) => s.trim().toLocaleLowerCase('vi');

/** Lựa chọn của leaf trùng nhãn (không phân biệt hoa thường, khoảng trắng hai đầu); không có thì giữ nhãn catalog. */
function optionOf(options: readonly AttributeOption[], label: string): { optionId: string | null; label: string } {
  const hit = options.find((o) => norm(o.label) === norm(label));
  return hit ? { optionId: hit.id, label: hit.label } : { optionId: null, label };
}

/**
 * Trục bán hàng và giá trị từng SKU. Nhiều trục cùng đích trong `axisMap` (trừ `__custom`) thành một thuộc tính biến thể ghép,
 * giá trị "Đỏ - S" (#568). Thứ tự trục theo SKU đầu; mọi SKU phải cùng bộ trục (`axis_shape`), nhiều SKU thì phải
 * có trục (TikTok `12052241`). Trục chưa ánh xạ trong `axisMap` thì `axis_unmapped`. Một SKU không thuộc tính: không trục.
 * Giá trị khớp lựa chọn của leaf theo nhãn (Lazada sale prop không tự đặt chỉ nhận nhãn có sẵn).
 */
export function groupVariants(
  variants: readonly GroupVariant[],
  axisMap: Readonly<Record<string, string>>,
  leaf: readonly PlatformAttribute[] | null,
): VariantGroup {
  const first = variants[0];
  if (!first) return { ok: false, code: 'axis_shape', message: 'Không có SKU nào để đẩy' };
  const ids = first.attributes.map((a) => a.attributeId);
  const key = ids.join('|');
  if (variants.some((v) => v.attributes.map((a) => a.attributeId).join('|') !== key)) {
    return { ok: false, code: 'axis_shape', message: 'Các SKU của sản phẩm không cùng bộ thuộc tính phân loại' };
  }
  if (variants.length > 1 && !ids.length) {
    return { ok: false, code: 'axis_shape', message: 'Sản phẩm nhiều SKU phải có thuộc tính phân loại' };
  }
  for (const [i, attributeId] of ids.entries()) {
    if (!axisMap[attributeId]) return { ok: false, code: 'axis_unmapped', message: `Chưa chọn thuộc tính phân loại của sàn cho "${first.attributes[i]!.attributeName}"` };
  }
  // Mỗi đích một thuộc tính biến thể của sàn; nhiều trục cùng đích thì giá trị nối theo thứ tự trục (#568, 21 §18.8.3).
  const groups = axisGroups(axisMap, ids).map((g) => g.attributeIds.map((id) => ids.indexOf(id)));
  const axes: GroupAxis[] = [];
  const valuesOf = new Map<string, string[]>(variants.map((v) => [v.id, []]));
  for (const at of groups) {
    const target = axisMap[ids[at[0]!]!]!;
    const code = target === CUSTOM_AXIS ? null : target;
    const sales = code ? leaf?.find((a) => a.code === code) : undefined;
    const name = sales?.label ?? first.attributes[at[0]!]!.attributeName;
    const axis: GroupAxis = { code, name, values: [] };
    for (const v of variants) {
      const value = optionOf(code ? (sales?.options ?? []) : [], joinValues(at.map((i) => v.attributes[i]!.value.trim())));
      if (!axis.values.some((x) => x.label === value.label)) axis.values.push(value);
      valuesOf.get(v.id)!.push(value.label);
    }
    axes.push(axis);
  }
  attachImages(variants, groups, axes, valuesOf);
  return { ok: true, axes, valuesOf };
}

/**
 * Ảnh theo giá trị (#295): trục gắn ảnh là trục có giá trị trùng `image.attributeValueId` của SKU. Sàn bắt buộc ảnh cho
 * **mọi** giá trị của trục đã gắn ảnh (TikTok OAS `sku_img`: "you must attach an image for each value of the chosen
 * attribute"), nên chỉ gắn khi mọi giá trị của trục trong lượt này có ảnh; thiếu một giá trị thì không gắn ảnh nào (catalog
 * đã báo `variantImages` ở độ hoàn thiện).
 */
function attachImages(
  variants: readonly GroupVariant[],
  groups: readonly (readonly number[])[],
  axes: GroupAxis[],
  valuesOf: Map<string, string[]>,
) {
  const withImage = variants.filter((v) => v.image?.url);
  if (!withImage.length) return;
  const count = variants[0]?.attributes.length ?? 0;
  const at = Array.from({ length: count }, (_, i) => i).find((i) => withImage.some((v) => v.attributes[i]?.valueId === v.image!.attributeValueId));
  if (at === undefined) return;
  // Trục gắn ảnh nằm trong thuộc tính biến thể ghép thì mỗi giá trị ghép lấy ảnh của giá trị trục ảnh của nó (#568).
  const g = groups.findIndex((x) => x.includes(at));
  const urlOf = new Map<string, string>();
  for (const v of withImage) {
    if (v.attributes[at]?.valueId !== v.image!.attributeValueId) continue;
    const label = valuesOf.get(v.id)![g]!;
    if (!urlOf.has(label)) urlOf.set(label, v.image!.url);
  }
  const axis = axes[g]!;
  if (!axis.values.every((x) => urlOf.has(x.label))) return;
  for (const x of axis.values) x.imageUrl = urlOf.get(x.label)!;
}
