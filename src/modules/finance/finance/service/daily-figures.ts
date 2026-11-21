// Gom sổ tiền theo ngày cho trang Tổng quan của insight (Documents/21 §21.5, #333). Chạy trong `withCompany` của bên gọi.
import { NET_REVENUE, NOT_SALES_PROFIT } from '../domain/ledger.ts';
import { type DailyFigureRow, dailyFigures } from '../repository/ledger.ts';

export type { DailyFigureRow };

/**
 * Dòng còn hiệu lực trong [from, to] (`occurred_on`, gồm hai đầu), một phần tử mỗi (ngày, gian hàng) có dòng.
 * `withShop`: `true` chỉ dòng có gian hàng, `false` chỉ dòng không gian hàng, bỏ trống là cả hai.
 */
export function getDailyLedgerFigures(
  from: string,
  to: string,
  scope: { shopId?: string | undefined; withShop?: boolean | undefined } = {},
): Promise<DailyFigureRow[]> {
  return dailyFigures(from, to, scope, { netRevenue: [...NET_REVENUE], notSalesProfit: [...NOT_SALES_PROFIT] });
}
