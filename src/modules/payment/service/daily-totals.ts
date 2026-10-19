// Hàm nguồn cho báo cáo (#29). Gọi trong `withCompany` của bên gọi.
import { Decimal } from 'decimal.js';
import { requireCompanyId } from '../../../shared/db/client.ts';
import { feesByDay } from '../repository/daily-totals.ts';

/** Phí cổng theo ngày (giờ VN, `YYYY-MM-DD`) và đơn, từ giao dịch thành công có `fee`. */
export async function getDailyPaymentFees(range: {
  from: string;
  to: string;
}): Promise<{ day: string; orderId: string; fee: Decimal }[]> {
  requireCompanyId('getDailyPaymentFees');
  return (await feesByDay(range.from, range.to)).map((r) => ({ day: r.day, orderId: r.order_id, fee: new Decimal(r.fee) }));
}
