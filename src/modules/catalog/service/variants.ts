// Khung của #12 PR2: chữ ký đã chốt (plan chuẩn bị 4.5, Documents/21 §11), #12 viết thân ở file này,
// không sửa catalog/index.ts. Gọi trong `withCompany` của bên gọi.
import { notImplemented } from '../../../shared/errors/app-error.ts';

/** Biến thể kèm sản phẩm, danh mục và giá trị thuộc tính (theo `position`) cho inventory, pricing, sales, channel. */
export interface VariantSummary {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  categoryId: string;
  categoryName: string;
  archived: boolean;
  attributes: { attributeId: string; attributeName: string; valueId: string; value: string; code: string }[];
}

/** Bỏ trống `ids` = mọi biến thể của công ty (D10 lọc trong bộ nhớ). Id không thấy (RLS) thì không có trong kết quả. */
export async function getVariants(_ids?: readonly string[]): Promise<VariantSummary[]> {
  throw notImplemented('getVariants', '#12');
}
