// Giá trị từng attribute của leaf lúc đọc spec và lúc đẩy (#509, Documents/21 §18.8.2). Luật thuần, không I/O: bên gọi nạp
// leaf, ghi đè, thông số catalog, ánh xạ, hồ sơ công ty. Thứ tự: ghi đè > catalog qua ánh xạ > hồ sơ công ty > mặc định sàn.
import { countryOption, type PlatformAttribute, resolveOption, type SpecAttributeValue } from './product-spec.ts';

export type ResolvedSource = 'override' | 'catalog' | 'company' | 'default';

export interface ResolvedValue {
  /** Select: mã lựa chọn của sàn khi khớp, nhãn khi gửi giá trị tự đặt; multiselect là mảng như vậy. */
  value: SpecAttributeValue;
  source: ResolvedSource;
  fieldId: string | null;
}

export type SpecFieldInput = 'select' | 'multiselect' | 'text' | 'number' | 'date';

/** Một thông số của sản phẩm (cổng `getProductSpecs` của catalog), đã xếp: trong mẫu nhóm theo vị trí, ngoài mẫu theo `code`. */
export interface CatalogSpecValue {
  fieldId: string;
  code: string;
  input: SpecFieldInput;
  /** Theo vị trí lựa chọn trong thông số; cùng thứ tự với `optionLabels`. */
  optionIds: string[];
  optionLabels: string[];
  /** `text`/`number`/`date` (date dạng `YYYY-MM-DD`). */
  value: string | null;
}

/** Một mã ánh xạ đã xác nhận (`suggested = false`) của thông số trên sàn đang xét. */
export interface FieldMapping {
  fieldId: string;
  attributeCode: string;
  priority: number;
  /** optionId của công ty → mã lựa chọn của sàn (`spec_option_mappings` của đúng mã này). */
  options: ReadonlyMap<string, string>;
}

export interface ResolveAdapter {
  readonly responsibleFields?: Readonly<Record<string, string>>;
  readonly productFields?: Readonly<Record<string, 'originCountry' | 'brand'>>;
  readonly defaultBrand?: string;
  /** Đổi `YYYY-MM-DD` sang định dạng sàn nhận; vắng thì `DD/MM/YYYY`. */
  formatDate?(iso: string): string;
}

export interface ResolveInput {
  /** Attribute của leaf; `null` khi chưa lấy (chỉ ghi đè, thương hiệu và hồ sơ công ty có nghĩa). */
  attributes: readonly PlatformAttribute[] | null;
  overrides: Readonly<Record<string, SpecAttributeValue>>;
  product: { brand: string | null; originCountry: string | null; specs: readonly CatalogSpecValue[] };
  mappings: readonly FieldMapping[];
  org: Readonly<Record<string, string | null | undefined>> | null;
}

const hasValue = (v: SpecAttributeValue | null | undefined): v is SpecAttributeValue =>
  v != null && (Array.isArray(v) ? v.length > 0 : v.trim() !== '');

export const optionsWithEn = (a: PlatformAttribute) => {
  const raw = Array.isArray(a.raw['options']) ? (a.raw['options'] as { id?: unknown; en_name?: unknown }[]) : [];
  const en = new Map(raw.map((o) => [String(o.id), typeof o.en_name === 'string' ? o.en_name : null]));
  return a.options.map((o) => ({ ...o, enLabel: en.get(o.id) ?? null }));
};

/** Lựa chọn khớp một số: nhãn là khoảng "a-b" chứa số, hoặc số đầu tiên của nhãn bằng số (bỏ dấu chấm, phẩy ngăn nghìn). */
export function numberOption(attr: Pick<PlatformAttribute, 'options'>, text: string): string | null {
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  const num = (s: string) => Number(s.replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.'));
  for (const o of attr.options) {
    const range = /(\d[\d.,]*)\s*[-–~]\s*(\d[\d.,]*)/.exec(o.label);
    if (range && n >= num(range[1]!) && n <= num(range[2]!)) return o.id;
  }
  for (const o of attr.options) {
    const first = /\d[\d.,]*/.exec(o.label);
    if (first && num(first[0]) === n && !/[-–~]/.test(o.label)) return o.id;
  }
  return null;
}

const defaultDate = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
};

/** Giá trị của một thông số cho một attribute; `null` khi không đặt được (lựa chọn lạ mà sàn không cho tự đặt). */
function catalogValue(
  attr: PlatformAttribute,
  spec: CatalogSpecValue,
  mapping: FieldMapping,
  adapter: ResolveAdapter,
): SpecAttributeValue | null {
  const leafIds = new Set(attr.options.map((o) => o.id));
  const pick = (optionId: string, label: string): string | null => {
    const mapped = mapping.options.get(optionId);
    if (mapped !== undefined && leafIds.has(mapped)) return mapped;
    // Chưa ánh xạ hoặc leaf không có lựa chọn đó: thử khớp nhãn với lựa chọn của leaf, không được thì tự đặt nếu sàn cho.
    const byLabel = attr.options.length ? resolveOption(attr, label) : null;
    if (byLabel !== null) return byLabel;
    return attr.allowCustom || attr.options.length === 0 ? label : null;
  };
  if (spec.input === 'select' || spec.input === 'multiselect') {
    const picked = spec.optionIds.map((id, i) => pick(id, spec.optionLabels[i] ?? '')).filter((v): v is string => v !== null);
    if (picked.length === 0) return null;
    return attr.input === 'multiselect' ? picked : picked[0]!;
  }
  if (spec.value === null || spec.value.trim() === '') return null;
  const text = spec.input === 'date' ? (adapter.formatDate ?? defaultDate)(spec.value) : spec.value;
  if (attr.options.length === 0) return attr.input === 'multiselect' ? [text] : text;
  const id = (spec.input === 'number' ? numberOption(attr, spec.value) : null) ?? resolveOption(attr, text);
  if (id !== null) return attr.input === 'multiselect' ? [id] : id;
  return attr.allowCustom ? text : null;
}

/**
 * Giá trị theo mã attribute (Documents/21 §18.8.2). Thương hiệu, xuất xứ (`productFields`) là thông số catalog có sẵn: catalog
 * thắng khoá cũ trong `overrides` vì người dùng không ghi đè được attribute `tier = 'product'` (khoá đó chỉ còn ở spec chép từ
 * ghép SKU, luật chuyển tiếp AC-15 của #400). Mỗi attribute nhận từ tối đa một thông số: thông số đứng trước trong
 * `product.specs` thắng; mỗi thông số lấy mã có `priority` nhỏ nhất mà leaf có.
 */
export function resolveSpecAttributes(adapter: ResolveAdapter, input: ResolveInput): Record<string, ResolvedValue> {
  const { attributes, overrides, product, mappings, org } = input;
  const byCode = new Map((attributes ?? []).map((a) => [a.code, a]));
  const out: Record<string, ResolvedValue> = {};

  for (const [code, value] of Object.entries(overrides)) {
    if (hasValue(value)) out[code] = { value, source: 'override', fieldId: null };
  }

  for (const [code, field] of Object.entries(adapter.productFields ?? {})) {
    const attr = byCode.get(code);
    if (field === 'brand') {
      if (product.brand) out[code] = { value: product.brand, source: 'catalog', fieldId: null };
    } else if (attr && product.originCountry) {
      const id = countryOption(product.originCountry, optionsWithEn(attr));
      if (id !== null) out[code] = { value: id, source: 'catalog', fieldId: null };
    }
  }

  if (attributes) {
    const taken = new Set<string>();
    for (const spec of product.specs) {
      const codes = mappings
        .filter((m) => m.fieldId === spec.fieldId)
        .sort((a, b) => a.priority - b.priority);
      const mapping = codes.find((m) => {
        const a = byCode.get(m.attributeCode);
        return a !== undefined && a.kind !== 'sales' && a.tier !== 'company' && a.tier !== 'product';
      });
      if (!mapping || taken.has(mapping.attributeCode)) continue;
      taken.add(mapping.attributeCode);
      if (out[mapping.attributeCode]) continue; // ghi đè thắng
      const value = catalogValue(byCode.get(mapping.attributeCode)!, spec, mapping, adapter);
      if (value !== null) out[mapping.attributeCode] = { value, source: 'catalog', fieldId: spec.fieldId };
    }
  }

  for (const [code, field] of Object.entries(adapter.responsibleFields ?? {})) {
    const v = org?.[field];
    if (!out[code] && v) out[code] = { value: v, source: 'company', fieldId: null };
  }

  for (const [code, field] of Object.entries(adapter.productFields ?? {})) {
    if (field === 'brand' && !out[code] && adapter.defaultBrand) {
      out[code] = { value: adapter.defaultBrand, source: 'default', fieldId: null };
    }
  }
  return out;
}

/** Giá trị phẳng (cho `specMissing`, so trùng lúc `PUT`). */
export const resolvedValues = (r: Record<string, ResolvedValue>): Record<string, SpecAttributeValue> =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.value]));
