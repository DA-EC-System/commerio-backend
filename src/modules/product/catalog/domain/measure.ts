// Cân nặng, kích thước gói của SKU (Documents/21 §17.5, #434): đi lên sàn và tính phí vận chuyển nên có trần. Mọi đường
// ghi (POST sản phẩm, PATCH SKU, sửa hàng loạt, PUT bản soạn của phiếu nhập; điền từ sàn `fillProductFacts` và ghi sổ
// phiếu nhận `applyDraftVariantFacts` thì bỏ số vượt) dùng chung; CHECK
// `product_variants_dimensions` giữ cùng trần ở DB.
import { z } from 'zod';

export const WEIGHT_MAX_G = 50_000;
export const EDGE_MAX_MM = 2_000;

const POSITIVE_INT = 'Nhập số nguyên lớn hơn 0';

/** Cân nặng gói (gam), 1–50.000; bỏ trường là giữ, `null` là xoá. */
export const weightG = z
  .int('Nhập số gam nguyên, vd 250')
  .positive(POSITIVE_INT)
  .max(WEIGHT_MAX_G, 'Cân nặng tối đa 50 kg')
  .nullable()
  .optional();

/** Một cạnh gói (mm), 1–2.000; bỏ trường là giữ, `null` là xoá. */
export const edgeMm = (label: 'Chiều dài' | 'Chiều rộng' | 'Chiều cao') =>
  z
    .int('Nhập số mm nguyên, vd 300')
    .positive(POSITIVE_INT)
    .max(EDGE_MAX_MM, `${label} tối đa 2.000 mm`)
    .nullable()
    .optional();
