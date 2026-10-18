// Hàm nguồn cho báo cáo (#29, plan chuẩn bị 4.5): chỉ #29 viết thân ở file này, không sửa payment/index.ts.
import type { Decimal } from 'decimal.js';
import { notImplemented } from '../../../shared/errors/app-error.ts';

/** Phí cổng theo ngày (giờ VN, `YYYY-MM-DD`) và đơn, từ giao dịch thành công có `fee`. */
export async function getDailyPaymentFees(_range: {
  from: string;
  to: string;
}): Promise<{ day: string; orderId: string; fee: Decimal }[]> {
  throw notImplemented('getDailyPaymentFees', '#29');
}
