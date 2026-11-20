// Gom các SKU của một sản phẩm cha thành một sản phẩm sàn nhiều phân loại (#295, Documents/21 §18.8.3–18.8.4). Hàm thuần.
import { type AttributeOption, CUSTOM_AXIS, type PlatformAttribute } from './product-spec.ts';

export interface GroupVariant {
  id: string;
  /** Giá trị thuộc tính theo `position` của catalog. */
  attributes: readonly { attributeId: string; attributeName: string; value: string }[];
}

export interface GroupAxis {
  /** Mã sale prop của leaf; null là trục tự đặt tên (`axisMap` = `__custom`). */
  code: string | null;
  name: string;
  values: { optionId: string | null; label: string }[];
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
 * Trục bán hàng và giá trị từng SKU. Thứ tự trục theo SKU đầu; mọi SKU phải cùng bộ trục (`axis_shape`), nhiều SKU thì phải
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
  const axes: GroupAxis[] = [];
  const valuesOf = new Map<string, string[]>(variants.map((v) => [v.id, []]));
  for (const [i, attributeId] of ids.entries()) {
    const target = axisMap[attributeId];
    const name = first.attributes[i]!.attributeName;
    if (!target) return { ok: false, code: 'axis_unmapped', message: `Chưa chọn thuộc tính phân loại của sàn cho "${name}"` };
    const code = target === CUSTOM_AXIS ? null : target;
    const sales = code ? leaf?.find((a) => a.code === code) : undefined;
    const axis: GroupAxis = { code, name: sales?.label ?? name, values: [] };
    for (const v of variants) {
      const value = optionOf(code ? (sales?.options ?? []) : [], v.attributes[i]!.value);
      if (!axis.values.some((x) => x.label === value.label)) axis.values.push(value);
      valuesOf.get(v.id)!.push(value.label);
    }
    axes.push(axis);
  }
  return { ok: true, axes, valuesOf };
}
