// Lý do chặn lưu trữ SKU phần mua hàng (#204, Documents/21 §17.3): catalog nhận hàm này qua `ctx` (product/index.ts) và
// gọi trong giao dịch lưu trữ của mình.
import { countingReceiptCounts, openRequestCounts, openSupplierReturnCounts } from '../repository/archive-blockers.ts';
import { incomingByVariant } from '../repository/requests.ts';

/**
 * Câu lý do theo SKU: hàng đang về, đề nghị nhập chưa xong, phiếu nhận đang kiểm, phiếu trả NCC chưa có kết quả. SKU
 * không vướng gì thì không có trong Map.
 */
export async function purchaseArchiveBlockers(variantIds: readonly string[]): Promise<Map<string, string[]>> {
  const ids = [...new Set(variantIds)];
  if (!ids.length) return new Map();
  // Tuần tự: các câu dùng chung một client của giao dịch.
  const incoming = await incomingByVariant(ids);
  const requests = await openRequestCounts(ids);
  const receipts = await countingReceiptCounts(ids);
  const returns = await openSupplierReturnCounts(ids);
  const result = new Map<string, string[]>();
  for (const id of ids) {
    const reasons: string[] = [];
    const comingIn = incoming.get(id) ?? 0;
    if (comingIn) reasons.push(`Đang về ${comingIn}`);
    if (requests.get(id)) reasons.push(`Còn ${requests.get(id)} đề nghị nhập chưa xong`);
    if (receipts.get(id)) reasons.push(`Còn ${receipts.get(id)} phiếu nhận đang kiểm`);
    if (returns.get(id)) reasons.push(`Còn ${returns.get(id)} phiếu trả NCC chưa có kết quả`);
    if (reasons.length) result.set(id, reasons);
  }
  return result;
}
