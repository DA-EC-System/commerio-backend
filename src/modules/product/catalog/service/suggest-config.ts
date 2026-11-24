import type { SuggestColumns } from '../repository/groups.ts';

/**
 * Cấu hình gợi ý khi sửa hàng loạt (#242) của nhóm hàng hoặc cài đặt công ty; `null` là chưa đặt (nhóm: theo công ty).
 * Hệ số là số thực (1,4 = lãi 40%).
 */
export interface SuggestConfig {
  marginCoefficient: number | null;
  priceRounding: number | null;
  reorderLeadDays: number | null;
  reorderSafetyQty: number | null;
  reorderDefaultQty: number | null;
}

export const NO_SUGGEST: SuggestConfig = {
  marginCoefficient: null,
  priceRounding: null,
  reorderLeadDays: null,
  reorderSafetyQty: null,
  reorderDefaultQty: null,
};

/** Cấu hình gửi lên: trường vắng là giữ, `null` là xoá. */
export type SuggestPatch = Partial<SuggestConfig>;

/** Gộp phần gửi lên vào cấu hình đang có: chỉ trường có mặt (kể cả `null`) mới đổi. */
export function mergeSuggest(current: SuggestConfig, patch: SuggestPatch | undefined): SuggestConfig {
  if (!patch) return current;
  const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  return { ...current, ...set };
}

/** Cột của DB sang cấu hình, hệ số ra số thực. */
export function suggestOf(c: SuggestColumns): SuggestConfig {
  return {
    marginCoefficient: c.marginCoefficient === null ? null : Number(c.marginCoefficient),
    priceRounding: c.priceRounding,
    reorderLeadDays: c.reorderLeadDays,
    reorderSafetyQty: c.reorderSafetyQty,
    reorderDefaultQty: c.reorderDefaultQty,
  };
}

export const columnsOf = (s: SuggestConfig): SuggestColumns => ({
  ...s,
  marginCoefficient: s.marginCoefficient === null ? null : s.marginCoefficient.toFixed(2),
});

/** Nhật ký chỉ nêu cấu hình gợi ý khi có giá trị nào đặt. */
export const withSuggest = <T extends object>(base: T, suggest: SuggestConfig) => ({
  ...base,
  ...(Object.values(suggest).some((v) => v !== null) && { suggest }),
});
