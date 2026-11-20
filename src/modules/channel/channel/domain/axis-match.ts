/**
 * Ghép trục phân loại của sản phẩm với sales attribute của sàn (#448, Documents/21 §18.8.3). Không I/O.
 *
 * Nguồn của `axisMap[attributeId]`, theo thứ tự: ghi đè của sản phẩm (không ở đây) → `channel.axis_mappings` của công ty →
 * mặc định theo `platform_kind` của thuộc tính → `__custom` nếu sàn nhận tên trục tự đặt, không thì bỏ trống (`missing`
 * `axis_unmapped`). `valueMap` ghép theo nhãn (bỏ dấu, chữ thường).
 */
import { CUSTOM_AXIS, normalizePath, type PlatformAttribute, type PlatformKind, type VariantCapabilities } from './product-spec.ts';

export type { PlatformKind, VariantCapabilities } from './product-spec.ts';

export interface AxisInput {
  attributeId: string;
  name: string;
  platformKind: PlatformKind | null;
  values: { valueId: string; value: string }[];
}

export interface SuggestAxesInput {
  axes: readonly AxisInput[];
  /** Attribute của leaf; null khi chưa lấy về. */
  leaf: readonly PlatformAttribute[] | null;
  /** `channel.axis_mappings` của công ty trên sàn: attributeId → mã sales attribute theo ưu tiên. */
  companyCodes: ReadonlyMap<string, readonly string[]>;
  /** Mặc định của adapter theo `platform_kind`, theo ưu tiên. */
  standard: Partial<Record<PlatformKind, readonly string[]>>;
  caps: VariantCapabilities | null;
}

export interface AxisSuggestion {
  axisMap: Record<string, string>;
  valueMap: Record<string, string>;
}

/** Nhãn tiếng Anh của lựa chọn trong bản gốc của sàn (Lazada `options[].en_name`), theo mã lựa chọn. */
function englishName(attr: PlatformAttribute, id: string): string | null {
  const raw = attr.raw['options'];
  if (!Array.isArray(raw)) return null;
  for (const o of raw as { id?: unknown; en_name?: unknown }[]) {
    if (o && String(o.id) === id && typeof o.en_name === 'string') return o.en_name;
  }
  return null;
}

/** Mã lựa chọn của sales attribute ứng với giá trị trục (nhãn hoặc tên tiếng Anh, bỏ dấu, chữ thường); không khớp thì null. */
function matchValue(attr: PlatformAttribute, value: string): string | null {
  const v = normalizePath(value);
  if (v === '') return null;
  for (const o of attr.options) {
    if (normalizePath(o.label) === v) return o.id;
    const en = englishName(attr, o.id);
    if (en !== null && normalizePath(en) === v) return o.id;
  }
  return null;
}

/** Không có `caps` (adapter chưa khai) thì coi như sàn nhận tên trục tự đặt, cùng luật với `specMissing`. */
export function suggestAxes(input: SuggestAxesInput): AxisSuggestion {
  const out: AxisSuggestion = { axisMap: {}, valueMap: {} };
  const { leaf } = input;
  if (leaf === null) return out;
  const sales = new Map(leaf.filter((a) => a.kind === 'sales').map((a) => [a.code, a]));
  const used = new Set<string>();
  for (const axis of input.axes) {
    const candidates = [...(input.companyCodes.get(axis.attributeId) ?? []), ...(axis.platformKind ? (input.standard[axis.platformKind] ?? []) : [])];
    const code = candidates.find((c) => sales.has(c) && !used.has(c));
    if (code !== undefined) {
      used.add(code);
      out.axisMap[axis.attributeId] = code;
      const attr = sales.get(code)!;
      if (attr.options.length) {
        for (const value of axis.values) {
          const id = matchValue(attr, value.value);
          if (id !== null) out.valueMap[value.valueId] = id;
        }
      }
    } else if (input.caps === null || input.caps.customAxisName) {
      out.axisMap[axis.attributeId] = CUSTOM_AXIS;
    }
  }
  return out;
}
