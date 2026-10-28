// Tính lại số liệu báo cáo từ dữ liệu gốc của các module nguồn (Documents/21 D7, D18; plan #29 A4).
import { getDailyFinanceTotals } from '../../../finance/index.ts';
import { getOrderCogs } from '../../../order/index.ts';
import { getDailyPaymentFees } from '../../../finance/index.ts';
import { getOrderChannels } from '../../../order/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { buildSummaryRows } from '../domain/summary.ts';
import { lockCompanySummary, replaceDays } from '../repository/summary.ts';

/**
 * Thay toàn bộ dòng của công ty trong [from, to] (ngày giờ VN, `YYYY-MM-DD`) bằng số tính lại từ module nguồn, trong
 * một giao dịch. Gọi lặp, gọi song song đều cho cùng kết quả: khoá công ty trước khi đọc nguồn.
 */
export async function recompute(companyId: string, from: string, to: string): Promise<void> {
  await withCompany(companyId, async () => {
    await lockCompanySummary(companyId);
    const range = { from, to };
    const finance = await getDailyFinanceTotals(range);
    const paymentFees = await getDailyPaymentFees(range);
    const orderIds = [...new Set([...finance.map((f) => f.orderId), ...paymentFees.map((p) => p.orderId)])];
    const invoiced = [...new Set(finance.filter((f) => f.invoiceNet !== 0).map((f) => f.orderId))];
    const channels = await getOrderChannels(orderIds);
    const cogs = await getOrderCogs(invoiced);
    await replaceDays(companyId, from, to, buildSummaryRows({ finance, paymentFees, cogs, channels }));
  });
}
