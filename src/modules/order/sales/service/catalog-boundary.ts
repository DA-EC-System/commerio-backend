// Cổng của sales cho catalog (#204, Documents/21 §17.3): lý do chặn lưu trữ SKU phần đơn. `src/wiring.ts` nối vào `ctx`
// của catalog (product ở lớp dưới order nên không gọi thẳng được). Gọi trong `withCompany` của bên gọi.
import { openOrderCounts, openReturnCountsByVariant } from '../repository/archive-blockers.ts';

/** Câu lý do theo SKU: đơn chưa xong, yêu cầu trả đang mở. SKU không vướng gì thì không có trong Map. */
export async function orderArchiveBlockers(variantIds: readonly string[]): Promise<Map<string, string[]>> {
  const ids = [...new Set(variantIds)];
  if (!ids.length) return new Map();
  const openOrders = await openOrderCounts(ids);
  const openReturns = await openReturnCountsByVariant(ids);
  const result = new Map<string, string[]>();
  for (const id of ids) {
    const reasons: string[] = [];
    if (openOrders.get(id)) reasons.push(`Còn ${openOrders.get(id)} đơn chưa xong`);
    if (openReturns.get(id)) reasons.push(`Còn ${openReturns.get(id)} yêu cầu trả đang mở`);
    if (reasons.length) result.set(id, reasons);
  }
  return result;
}
