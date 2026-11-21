// Gom các SKU của một sản phẩm cha thành một sản phẩm sàn nhiều phân loại (#295, Documents/21 §18.8.3–18.8.4). Hàm thuần.
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
  attachImages(variants, ids, axes, valuesOf);
  return { ok: true, axes, valuesOf };
}

/**
 * Ảnh theo giá trị (#295): trục gắn ảnh là trục có giá trị trùng `image.attributeValueId` của SKU. Sàn bắt buộc ảnh cho
 * **mọi** giá trị của trục đã gắn ảnh (TikTok OAS `sku_img`: "you must attach an image for each value of the chosen
 * attribute"), nên chỉ gắn khi mọi giá trị của trục trong lượt này có ảnh; thiếu một giá trị thì không gắn ảnh nào (catalog
 * đã báo `variantImages` ở độ hoàn thiện).
 */
function attachImages(variants: readonly GroupVariant[], ids: readonly string[], axes: GroupAxis[], valuesOf: Map<string, string[]>) {
  const withImage = variants.filter((v) => v.image?.url);
  if (!withImage.length) return;
  const at = ids.findIndex((_, i) => withImage.some((v) => v.attributes[i]?.valueId === v.image!.attributeValueId));
  if (at < 0) return;
  const urlOf = new Map<string, string>();
  for (const v of withImage) {
    if (v.attributes[at]?.valueId !== v.image!.attributeValueId) continue;
    const label = valuesOf.get(v.id)![at]!;
    if (!urlOf.has(label)) urlOf.set(label, v.image!.url);
  }
  const axis = axes[at]!;
  if (!axis.values.every((x) => urlOf.has(x.label))) return;
  for (const x of axis.values) x.imageUrl = urlOf.get(x.label)!;
}
