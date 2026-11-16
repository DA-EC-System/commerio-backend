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

/**
 * Giá muốn bán = giá nhập × hệ số lãi của danh mục, làm tròn LÊN theo bước của danh mục (không đặt thì bước 1 đồng).
 * 100.000 × 1,4 = 140.000. `showCost` false (không có `inventory.cost.view`) thì câu giải thích không nêu giá nhập.
 */
export function suggestTargetPrice(
  cost: Decimal.Value,
  config: { marginCoefficient: number; priceRounding: number | null },
  showCost: boolean,
): Suggestion {
  const step = config.priceRounding ?? 1;
  const value = new Decimal(cost).mul(config.marginCoefficient).div(step).ceil().mul(step).toNumber();
  const how = `${showCost ? `${dong(new Decimal(cost).toNumber())} giá nhập` : 'giá nhập'} × hệ số lãi ${factor(config.marginCoefficient)} của danh mục`;
  return { value, basis: config.priceRounding ? `${how}, làm tròn lên ${dong(step)}` : how };
}

/**
 * Ngưỡng tồn: có lịch sử bán thì `tốc độ bán/ngày × số ngày chờ hàng + tồn an toàn`, làm tròn lên; chưa có lịch sử thì
 * mặc định của danh mục. Thiếu cấu hình cần cho nhánh đó thì không gợi ý (trả `null`).
 */
export function suggestMinQty(input: {
  soldQty: number;
  leadDays: number | null;
  safetyQty: number | null;
  defaultQty: number | null;
}): Suggestion | null {
  if (input.soldQty > 0 && input.leadDays !== null) {
    const perDay = input.soldQty / SALES_WINDOW_DAYS;
    const safety = input.safetyQty ?? 0;
    const value = Math.ceil(perDay * input.leadDays) + safety;
    return {
      value,
      basis: `bán ${input.soldQty} trong ${SALES_WINDOW_DAYS} ngày (${factor(Math.round(perDay * 100) / 100)}/ngày) × ${input.leadDays} ngày chờ hàng + ${safety} tồn an toàn`,
    };
  }
  if (input.defaultQty !== null) {
    return {
      value: input.defaultQty,
      basis: input.soldQty > 0 ? 'mặc định của danh mục (danh mục chưa đặt số ngày chờ hàng)' : 'chưa có lịch sử bán, lấy mặc định của danh mục',
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
