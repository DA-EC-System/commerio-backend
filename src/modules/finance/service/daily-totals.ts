// Hàm nguồn cho báo cáo (#29, plan chuẩn bị 4.5): chỉ #29 viết thân ở file này, không sửa finance/index.ts.
import type { Decimal } from 'decimal.js';
import { notImplemented } from '../../../shared/errors/app-error.ts';

/**
 * Doanh thu (hoá đơn đã ghi sổ, chứng từ đảo trừ vào ngày đảo), tiền đã thu (phiếu thu), đã hoàn (phiếu chi hoàn tiền)
 * theo ngày (giờ VN, `YYYY-MM-DD`) và đơn.
 */
export async function getDailyFinanceTotals(_range: {
  from: string;
  to: string;
}): Promise<{ day: string; orderId: string | null; revenue: Decimal; cashCollected: Decimal; refunded: Decimal }[]> {
  throw notImplemented('getDailyFinanceTotals', '#29');
}
