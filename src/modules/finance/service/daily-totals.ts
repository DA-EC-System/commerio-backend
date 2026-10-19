// Hàm nguồn cho báo cáo (#29, plan #29 A1–A3). Gọi trong `withCompany` của bên gọi.
import { Decimal } from 'decimal.js';
import { currentCompanyId } from '../../../shared/db/client.ts';
import { financeDays, settlementByOrder } from '../repository/daily-totals.ts';

export interface DailyFinanceTotal {
  /** Ngày giờ VN, `YYYY-MM-DD`. */
  day: string;
  orderId: string;
  /** Hoá đơn đã ghi sổ trong ngày; hoá đơn đảo trừ vào ngày đảo. */
  revenue: Decimal;
  /** Phiếu thu trong ngày (phiếu đảo âm). */
  cashCollected: Decimal;
  /** Phiếu chi hoàn tiền khách đã ghi sổ trong ngày (phiếu đảo âm). */
  refunded: Decimal;
  /** Số hoá đơn gốc − số hoá đơn đảo của đơn trong ngày: hệ số cho giá vốn, phí sàn, vận chuyển sàn (A1). */
  invoiceNet: number;
  /** Phí sàn, vận chuyển sàn của **cả đơn** (chưa nhân hệ số); chỉ tra cho đơn có hoá đơn trong khoảng, còn lại 0. */
  platformFee: Decimal;
  shippingCost: Decimal;
  /** Đơn đã có dòng đối soát (mọi trạng thái khớp). */
  settled: boolean;
}

/**
 * Doanh thu, tiền đã thu, đã hoàn theo ngày (giờ VN) và đơn, kèm phí sàn của đơn có hoá đơn trong ngày. Chỉ chứng từ
 * có đơn (plan #29 A2).
 */
export async function getDailyFinanceTotals(range: { from: string; to: string }): Promise<DailyFinanceTotal[]> {
  if (!currentCompanyId()) throw new Error('getDailyFinanceTotals phải gọi trong withCompany: số liệu thuộc một công ty');
  const days = await financeDays(range.from, range.to);
  const invoiced = [...new Set(days.filter((d) => d.invoice_net !== 0).map((d) => d.order_id))];
  const settlement = new Map((await settlementByOrder(invoiced)).map((s) => [s.order_id, s]));
  return days.map((d) => {
    const s = settlement.get(d.order_id);
    return {
      day: d.day,
      orderId: d.order_id,
      revenue: new Decimal(d.revenue),
      cashCollected: new Decimal(d.cash_collected),
      refunded: new Decimal(d.refunded),
      invoiceNet: d.invoice_net,
      platformFee: new Decimal(s?.platform_fee ?? 0),
      shippingCost: new Decimal(s?.shipping_cost ?? 0),
      settled: s !== undefined,
    };
  });
}
