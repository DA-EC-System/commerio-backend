// Điều kiện dữ liệu để đẩy một biến thể lên sàn (#219, Documents/21 §18.5, §18.6.4); dùng chung cho request `push`
// (`listings.ts`) và việc nền (`listing-push.ts`), tách riêng để hai file không import vòng.
import type { Decimal } from 'decimal.js';
import type { CategoryMapRow } from '../repository/category-maps.ts';
import type { ListingVariant } from './product-port.ts';

/** Lý do một dòng không đẩy được, theo bảng mã 21 §18.5 và `sku_not_ready` (§18.6.4). */
export interface PushBlock {
  code: 'sku_not_ready' | 'price_missing' | 'category_unmapped' | 'dimensions_missing' | 'images_missing';
  message: string;
}

/**
 * Dữ liệu đủ để đẩy chưa; dùng chung cho request (`listings.ts`) và việc nền (dữ liệu có thể đổi giữa hai lúc).
 * `hasImages`: listing đã có ảnh trên sàn, hoặc sản phẩm có ảnh trong catalog (#303).
 */
export function pushBlock(v: ListingVariant, price: Decimal | null, map: CategoryMapRow | undefined, hasImages: boolean): PushBlock | null {
  // Tạm dùng trạng thái kinh doanh tới khi #204 trả `readiness` của SKU (#219 A2, Documents/25 §6.3).
  if (v.businessStatus === 'paused') return { code: 'sku_not_ready', message: 'SKU đang tạm ngừng kinh doanh, chưa đẩy được' };
  if (price === null) return { code: 'price_missing', message: 'Chưa có giá chuẩn' };
  if (!map) return { code: 'category_unmapped', message: 'Danh mục chưa ghép với danh mục của sàn' };
  if (!v.weightG || !v.lengthMm || !v.widthMm || !v.heightMm) {
    return { code: 'dimensions_missing', message: 'Thiếu cân nặng hoặc kích thước gói của SKU' };
  }
  if (!hasImages) return { code: 'images_missing', message: 'Sàn bắt buộc ảnh: thêm ảnh cho sản phẩm' };
  return null;
}
