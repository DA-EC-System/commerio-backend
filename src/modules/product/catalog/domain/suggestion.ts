// Gợi ý khi sửa hàng loạt (#242, Documents/25 §5.3, 27 US-SP-04). Hàm thuần: số liệu do service đọc từ DB và đưa vào.
// Gợi ý chỉ là số kèm câu giải thích (`basis`); không có gì được lưu tới khi người dùng gửi lên.
import { Decimal } from 'decimal.js';

/** Số ngày bán gần nhất để tính tốc độ bán. */
export const SALES_WINDOW_DAYS = 30;

export interface Suggestion {
  value: number;
  /** Cách ra số, hiện khi rê chuột vào nhãn "gợi ý". */
  basis: string;
}

const dong = (n: number) => `${n.toLocaleString('vi-VN')} đ`;
const factor = (n: number) => n.toLocaleString('vi-VN');

/** Năm số cấu hình gợi ý; `null` là chưa đặt. */
export interface SuggestNumbers {
  marginCoefficient: number | null;
  priceRounding: number | null;
  reorderLeadDays: number | null;
  reorderSafetyQty: number | null;
  reorderDefaultQty: number | null;
}

/** Một số cấu hình kèm nơi lấy, để câu giải thích nêu nguồn ("theo nhóm Điện tử", "theo công ty"). */
export type Sourced = { value: number; source: string } | null;

/**
 * Cấu hình gợi ý của một sản phẩm (Documents/21 mục 17.5, `productSuggestConfig`): từng số lấy ở nhóm hàng, nhóm để
 * trống thì lấy ở cài đặt công ty; cả hai trống thì không có.
 */
export function productSuggestConfig(group: SuggestNumbers & { name: string }, company: SuggestNumbers): Record<keyof SuggestNumbers, Sourced> {
  const pick = (field: keyof SuggestNumbers): Sourced => {
    if (group[field] !== null) return { value: group[field], source: `theo nhóm ${group.name}` };
    if (company[field] !== null) return { value: company[field], source: 'theo công ty' };
    return null;
  };
  return {
    marginCoefficient: pick('marginCoefficient'),
    priceRounding: pick('priceRounding'),
    reorderLeadDays: pick('reorderLeadDays'),
    reorderSafetyQty: pick('reorderSafetyQty'),
    reorderDefaultQty: pick('reorderDefaultQty'),
  };
}

/**
 * Giá muốn bán = giá nhập × hệ số lãi, làm tròn LÊN theo bước làm tròn (không đặt thì bước 1 đồng). 100.000 × 1,4 =
 * 140.000. `source` là nơi lấy hệ số ("theo nhóm Điện tử", "theo công ty"). `showCost` false (không có
 * `inventory.cost.view`) thì câu giải thích không nêu giá nhập.
 */
export function suggestTargetPrice(
  cost: Decimal.Value,
  config: { marginCoefficient: number; priceRounding: number | null; source: string },
  showCost: boolean,
): Suggestion {
  const step = config.priceRounding ?? 1;
  const value = new Decimal(cost).mul(config.marginCoefficient).div(step).ceil().mul(step).toNumber();
  const how = `${showCost ? `${dong(new Decimal(cost).toNumber())} giá nhập` : 'giá nhập'} × hệ số lãi ${factor(config.marginCoefficient)} ${config.source}`;
  return { value, basis: config.priceRounding ? `${how}, làm tròn lên ${dong(step)}` : how };
}

/**
 * Ngưỡng tồn: có lịch sử bán thì `tốc độ bán/ngày × số ngày chờ hàng + tồn an toàn`, làm tròn lên; chưa có lịch sử thì
 * ngưỡng mặc định. Mỗi số kèm nguồn (`productSuggestConfig`). Thiếu cấu hình cần cho nhánh đó thì không gợi ý.
 */
export function suggestMinQty(input: { soldQty: number; leadDays: Sourced; safetyQty: Sourced; defaultQty: Sourced }): Suggestion | null {
  if (input.soldQty > 0 && input.leadDays) {
    const perDay = input.soldQty / SALES_WINDOW_DAYS;
    const safety = input.safetyQty?.value ?? 0;
    const value = Math.ceil(perDay * input.leadDays.value) + safety;
    return {
      value,
      basis: `bán ${input.soldQty} trong ${SALES_WINDOW_DAYS} ngày (${factor(Math.round(perDay * 100) / 100)}/ngày) × ${input.leadDays.value} ngày chờ hàng + ${safety} tồn an toàn, ${input.leadDays.source}`,
    };
  }
  if (input.defaultQty) {
    const { source } = input.defaultQty;
    return {
      value: input.defaultQty.value,
      basis: input.soldQty > 0 ? `ngưỡng mặc định ${source} (chưa đặt số ngày chờ hàng)` : `chưa có lịch sử bán, lấy ngưỡng mặc định ${source}`,
    };
  }
  return null;
}

/** Trường lấy từ SKU anh em gần nhất khi ô còn trống. */
export const SIBLING_FIELDS = ['standardPrice', 'targetNetPrice', 'weightG', 'lengthMm', 'widthMm', 'heightMm'] as const;
export type SiblingField = (typeof SIBLING_FIELDS)[number];

export interface SiblingValues {
  sku: string;
  values: Record<SiblingField, number | null>;
}

/** Ô còn trống thì chép số từ SKU anh em gần nhất (đầu danh sách) đã có số ở ô đó. */
export function suggestFromSiblings(field: SiblingField, siblings: readonly SiblingValues[]): Suggestion | null {
  const found = siblings.find((s) => s.values[field] !== null);
  return found ? { value: found.values[field]!, basis: `chép từ SKU ${found.sku} cùng sản phẩm` } : null;
}
