// Cổng của channel cho catalog (#204, Documents/21 §17.3): lý do chặn lưu trữ SKU phần sàn. `src/wiring.ts` nối vào
// `ctx` của catalog (product ở lớp dưới channel nên không gọi thẳng được). Gọi trong `withCompany` của bên gọi.
import { pushingListingCounts } from '../repository/archive-blockers.ts';

/** Câu lý do theo SKU: listing đang đẩy lên sàn (`pushing`). SKU không vướng gì thì không có trong Map. */
export async function listingArchiveBlockers(variantIds: readonly string[]): Promise<Map<string, string[]>> {
  const pushing = await pushingListingCounts([...new Set(variantIds)]);
  return new Map([...pushing].map(([id, n]) => [id, [`Còn ${n} listing đang đẩy lên sàn`]]));
}
