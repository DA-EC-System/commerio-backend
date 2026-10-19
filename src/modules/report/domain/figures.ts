// Số liệu trả cho API báo cáo (Documents/21 §12.7, §12.8 `ReportFigures`; plan #29 AC-12, AC-15). Thuần, không I/O.
import { Decimal } from 'decimal.js';
import { addDays, daysBetween } from './days.ts';
import { MONEY, type OrderSource } from './summary.ts';

/** Dòng đã lưu của bảng, tiền là chuỗi số nguyên đồng (`.00`, làm tròn lúc tính lại). */
export interface StoredRow {
  day: string;
  source: OrderSource;
  shopId: string | null;
  revenue: string;
  cashCollected: string;
  platformFee: string;
  paymentFee: string;
  shippingFee: string;
  cogs: string;
  feesPending: boolean;
}

export interface ReportFigures {
  revenue: number;
  cashCollected: number;
  platformFee: number;
  paymentFee: number;
  shippingFee: number;
  /** `null` khi người xem không có `inventory.cost.view` (D18, K3). */
  cogs: number | null;
  profit: number | null;
  /** Có ngày chưa đối soát nên phí sàn đang là 0. */
  feesPending: boolean;
}

/** Cộng các dòng; lãi là hiệu các tổng (QT-45), nên `total` luôn bằng tổng các dòng con. */
export function sumFigures(rows: readonly StoredRow[], canCost: boolean): ReportFigures {
  const sum = Object.fromEntries(
    MONEY.map((k) => [k, rows.reduce((acc, r) => acc.plus(r[k]), new Decimal(0))]),
  ) as Record<(typeof MONEY)[number], Decimal>;
  const profit = sum.revenue.minus(sum.cogs).minus(sum.platformFee).minus(sum.paymentFee).minus(sum.shippingFee);
  return {
    revenue: sum.revenue.toNumber(),
    cashCollected: sum.cashCollected.toNumber(),
    platformFee: sum.platformFee.toNumber(),
    paymentFee: sum.paymentFee.toNumber(),
    shippingFee: sum.shippingFee.toNumber(),
    cogs: canCost ? sum.cogs.toNumber() : null,
    profit: canCost ? profit.toNumber() : null,
    feesPending: rows.some((r) => r.feesPending),
  };
}

const DEFAULT_DAYS = 30;
const MAX_DAYS = 366;

/**
 * Khoảng ngày của API (§12.7): thiếu cả hai là 30 ngày tính tới hôm nay; chỉ có `to` thì `from = to − 29`; chỉ có
 * `from` thì `to` = hôm nay. `to` ở tương lai được nhận. Sai thì trả lỗi theo ô.
 */
export function resolveRange(
  q: { from?: string | undefined; to?: string | undefined },
  today: string,
): { from: string; to: string } | { errors: Record<string, string> } {
  if (q.from && !q.to && q.from > today) return { errors: { from: 'Từ ngày không được sau hôm nay' } };
  const to = q.to ?? today;
  const from = q.from ?? addDays(to, -(DEFAULT_DAYS - 1));
  if (from > to) return { errors: { from: 'Từ ngày phải trước hoặc bằng đến ngày' } };
  if (daysBetween(from, to) > MAX_DAYS) return { errors: { to: `Khoảng ngày tối đa ${MAX_DAYS} ngày` } };
  return { from, to };
}
