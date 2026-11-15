// Kiểu và cột tiền của `insight.daily_channel_summary` (plan #29). Hàm dựng dòng từ chứng từ cũ (hoá đơn, phiếu thu)
// đã gỡ ở #235 cùng `service/recompute.ts`; báo cáo đọc từ sổ tiền làm ở issue khác.
import type { OrderSource } from '../../../order/index.ts';

export type { OrderSource };

/** Các cột tiền (trừ lãi, là hiệu của chúng). */
export const MONEY = ['revenue', 'cashCollected', 'platformFee', 'paymentFee', 'shippingFee', 'cogs'] as const;
