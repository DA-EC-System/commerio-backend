// Số liệu trả cho API báo cáo (Documents/21 §21.5 `ReportFigures`, #333). Thuần, không I/O.
import { Decimal } from 'decimal.js';
import { addDays, daysBetween } from './days.ts';
import type { OrderSource } from './summary.ts';

/** Một (ngày, gian hàng) của sổ tiền đã gom (`finance.getDailyLedgerFigures`); tiền là chuỗi có dấu như sổ. */
export interface DayRow {
  day: string;
  shopId: string | null;
  revenue: string;
  net: string;
  cogs: string;
  cashCollected: string;
  platformFee: string;
  shippingFee: string;
  estimated: boolean;
}

export interface ReportFigures {
  /** Doanh thu thuần: `revenue` + `customer_refund`. */
  revenue: number;
  /** Thực nhận: dòng tiền của bán hàng, bỏ giá vốn và khoản ngoài lãi bán hàng (25 §10.1). */
  net: number;
  /** Phần thực nhận sàn đã quyết toán. */
  cashCollected: number;
  platformFee: number;
  /** Sàn không tách phí thanh toán khỏi phí giao dịch: luôn 0. */
  paymentFee: number;
  shippingFee: number;
  /** Âm như sổ; `null` khi người xem không có `inventory.cost.view` (D18, R4). */
  cogs: number | null;
  /** Lãi gộp = thực nhận + giá vốn; `null` như `cogs`. */
  profit: number | null;
  /** Còn dòng tiền ước tính chưa có số thật thay. */
  estimated: boolean;
  /** Bằng `estimated`, giữ cho bên gọi cũ. */
  feesPending: boolean;
}

const MONEY = ['revenue', 'net', 'cogs', 'cashCollected', 'platformFee', 'shippingFee'] as const;

/** Nguồn của dòng sổ: có gian hàng là sàn, không có là ngoài sàn. Sổ không tách đơn hộp thư. */
export const sourceOf = (shopId: string | null): OrderSource => (shopId ? 'marketplace' : 'manual');

/** Cộng các dòng; lãi là hiệu các tổng nên `total` luôn bằng tổng các dòng con. */
export function sumFigures(rows: readonly DayRow[], canCost: boolean): ReportFigures {
  const sum = Object.fromEntries(
    MONEY.map((k) => [k, rows.reduce((acc, r) => acc.plus(r[k]), new Decimal(0))]),
  ) as Record<(typeof MONEY)[number], Decimal>;
  const estimated = rows.some((r) => r.estimated);
  return {
    revenue: sum.revenue.toNumber(),
    net: sum.net.toNumber(),
    cashCollected: sum.cashCollected.toNumber(),
    platformFee: sum.platformFee.toNumber(),
    paymentFee: 0,
    shippingFee: sum.shippingFee.toNumber(),
    cogs: canCost ? sum.cogs.toNumber() : null,
    profit: canCost ? sum.net.plus(sum.cogs).toNumber() : null,
    estimated,
    feesPending: estimated,
  };
}

const DEFAULT_DAYS = 30;
const MAX_DAYS = 366;

/**
 * Khoảng ngày của API (Documents/21 §21.5): thiếu cả hai là 30 ngày tính tới hôm nay; chỉ có `to` thì `from = to − 29`; chỉ có
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
