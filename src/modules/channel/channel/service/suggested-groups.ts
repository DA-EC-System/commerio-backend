// Danh mục chuẩn gợi ý theo category sàn (#569, Documents/21 §18.5): bảng `platform_category_group_maps` của nền tảng,
// đi từ category lên gốc, lấy dòng sâu nhất; danh mục đã xoá hay công ty ẩn thì không gợi ý. Channel trả `groupId`,
// catalog không đọc bảng này.
import { mappedGroupsOf } from '../repository/category-sync-state.ts';
import type { ProductPort } from './product-port.ts';

/** Gọi trong `withCompany`. Category không có gợi ý thì vắng mặt trong Map. */
export async function suggestedGroupsOf(
  port: Pick<ProductPort, 'visibleGroupIds'>,
  platform: string,
  externalCategoryIds: readonly string[],
): Promise<Map<string, string>> {
  const mapped = await mappedGroupsOf(platform, externalCategoryIds);
  if (!mapped.size || !port.visibleGroupIds) return mapped;
  const visible = await port.visibleGroupIds([...mapped.values()]);
  return new Map([...mapped].filter(([, groupId]) => visible.has(groupId)));
}
