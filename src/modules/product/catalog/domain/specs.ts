// Luật thuần của thông số sản phẩm (Documents/21 mục 5.5 "SpecInput"). Không I/O.
import { Decimal } from 'decimal.js';

/**
 * Loại thuộc tính chuẩn sàn (21 mục 5.2, 18.8.3): bước Variants của trang đẩy ghép sang sales attribute chuẩn của sàn.
 * `volume` (dung tích, khối lượng, quy cách) và `flavor` (hương vị) cho mỹ phẩm, thực phẩm (research P4, 21/11/2026).
 */
export const PLATFORM_KINDS = ['color', 'size', 'volume', 'flavor'] as const;
export type PlatformKind = (typeof PLATFORM_KINDS)[number];

/** Kiểu nhập của thông số (Documents/19 §3.2): `date` lưu `YYYY-MM-DD` (ngày cấp giấy phép, research P6). */
export const SPEC_INPUTS = ['select', 'multiselect', 'text', 'number', 'date'] as const;
export type SpecInputKind = (typeof SPEC_INPUTS)[number];

export const SPEC_TEXT_MAX = 2000;
export const SPEC_MULTI_MAX = 20;
export const SPEC_OPTION_MAX = 60;

/** Mã sinh từ tên: bỏ dấu, chữ thường, ký tự khác chữ số thành `_`; chừa 4 ký tự cho hậu tố `_n` (mã ≤ 40). */
export function specCodeFromName(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 36)
    .replace(/_+$/, '');
  return base || 'thong_so';
}

/** Mã đầu tiên chưa dùng: `base`, rồi `base_2`, `base_3`… */
export function uniqueSpecCode(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
}

/** Số thập phân ≥ 0, tối đa 3 chữ số lẻ, dạng chuẩn hoá (`007.50` → `7.5`); sai thì `null`. */
export function normalizeSpecNumber(value: string): string | null {
  const v = value.trim();
  if (!/^\d{1,15}(\.\d{1,3})?$/.test(v)) return null;
  return new Decimal(v).toFixed();
}

/** Ngày `YYYY-MM-DD` có thật. */
export function isSpecDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

export interface SpecFieldDef {
  input: SpecInputKind;
  allowCustom: boolean;
  /** Lựa chọn của thông số: id → giá trị. */
  options: ReadonlyMap<string, string>;
}

export interface SpecValueInput {
  optionIds?: readonly string[] | undefined;
  newValues?: readonly string[] | undefined;
  value?: string | undefined;
}

/** Kết quả kiểm một `SpecInput`: xoá giá trị, chữ đã chuẩn hoá, hoặc lựa chọn (có sẵn + chữ mới chưa khớp lựa chọn nào). */
export type SpecValuePlan =
  { kind: 'clear' } | { kind: 'text'; text: string } | { kind: 'options'; optionIds: string[]; newValues: string[] };

const key = (s: string) => s.trim().toLowerCase();

/** Kiểm một giá trị theo kiểu nhập của thông số; lỗi trả câu cho ô `specs.<i>`. */
export function planSpecValue(field: SpecFieldDef, input: SpecValueInput): SpecValuePlan | { error: string } {
  const { input: kind } = field;
  if (kind === 'select' || kind === 'multiselect') {
    if (input.value !== undefined)
      return {
        error: 'Thông số chọn từ danh sách, gửi optionIds hoặc newValues',
      };
    const ids = [...new Set(input.optionIds ?? [])];
    const fresh = (input.newValues ?? []).map((v) => v.trim());
    if (!ids.length && !fresh.length) return { kind: 'clear' };
    if (ids.some((id) => !field.options.has(id))) return { error: 'Có lựa chọn không thuộc thông số này' };
    if (fresh.length && !field.allowCustom) return { error: 'Thông số này chỉ nhận lựa chọn có sẵn' };
    if (fresh.some((v) => v.length < 1 || v.length > SPEC_OPTION_MAX)) return { error: `Lựa chọn mới dài 1–${SPEC_OPTION_MAX} ký tự` };
    // Chữ mới trùng lựa chọn có sẵn (theo `lower(trim)`) thì dùng lựa chọn đó.
    const byKey = new Map([...field.options].map(([id, v]) => [key(v), id]));
    const optionIds = [...ids];
    const newValues: string[] = [];
    const seen = new Set<string>();
    for (const v of fresh) {
      const k = key(v);
      const existing = byKey.get(k);
      if (existing) {
        if (!optionIds.includes(existing)) optionIds.push(existing);
      } else if (!seen.has(k)) {
        seen.add(k);
        newValues.push(v);
      }
    }
    const count = optionIds.length + newValues.length;
    if (kind === 'select' && count !== 1) return { error: 'Chọn đúng một giá trị' };
    if (count > SPEC_MULTI_MAX) return { error: `Chọn tối đa ${SPEC_MULTI_MAX} giá trị` };
    return { kind: 'options', optionIds, newValues };
  }
  if (input.optionIds?.length || input.newValues?.length) return { error: 'Thông số này nhập chữ, gửi value' };
  const raw = (input.value ?? '').trim();
  if (!raw) return { kind: 'clear' };
  if (kind === 'text') return raw.length > SPEC_TEXT_MAX ? { error: `Tối đa ${SPEC_TEXT_MAX} ký tự` } : { kind: 'text', text: raw };
  if (kind === 'number') {
    const n = normalizeSpecNumber(raw);
    return n === null ? { error: 'Nhập số ≥ 0, tối đa 3 chữ số thập phân' } : { kind: 'text', text: n };
  }
  return isSpecDate(raw) ? { kind: 'text', text: raw } : { error: 'Nhập ngày dạng YYYY-MM-DD' };
}
