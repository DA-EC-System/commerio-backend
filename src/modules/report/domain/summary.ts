// Dựng dòng `report.daily_channel_summary` từ số của các module nguồn (plan #29 A1, A2, A12, AC-12). Thuần, không I/O.
import { Decimal } from 'decimal.js';
import type { OrderSource } from '../../sales/index.ts';

export type { OrderSource };

/** Số đọc từ bốn hàm nguồn cho một khoảng ngày (kiểu khớp `finance`, `payment`, `inventory`, `sales` `index.ts`). */
export interface SourceData {
  finance: readonly {
    day: string;
    orderId: string;
    revenue: Decimal;
    cashCollected: Decimal;
    refunded: Decimal;
    invoiceNet: number;
    platformFee: Decimal;
    shippingCost: Decimal;
    settled: boolean;
  }[];
  paymentFees: readonly { day: string; orderId: string; fee: Decimal }[];
  cogs: ReadonlyMap<string, Decimal>;
  channels: ReadonlyMap<string, { source: OrderSource; shopId: string | null }>;
}

export interface SummaryRow {
  day: string;
  source: OrderSource;
  shopId: string | null;
  revenue: Decimal;
  cashCollected: Decimal;
  platformFee: Decimal;
  paymentFee: Decimal;
  shippingFee: Decimal;
  cogs: Decimal;
  profit: Decimal;
  feesPending: boolean;
}

/** Các cột tiền (trừ lãi, là hiệu của chúng). */
export const MONEY = ['revenue', 'cashCollected', 'platformFee', 'paymentFee', 'shippingFee', 'cogs'] as const;

/** Làm tròn tới đồng, nửa lên; số âm ra xa 0 (−0,5 → −1). */
const toDong = (v: Decimal) => v.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);

/**
 * Một dòng mỗi (ngày, nguồn, gian hàng). Giá vốn, phí sàn, vận chuyển sàn của đơn nhân hệ số hoá đơn ròng của ngày
 * (A1); tiền đã thu trừ hoàn tiền khách (A12). Mỗi thành phần làm tròn một lần trên dòng, lãi là hiệu các số đã làm
 * tròn, nên mọi phép cộng dòng ở API cho kết quả khớp nhau (AC-12). Đơn không có nguồn (không thấy ở sales) bị bỏ;
 * dòng toàn 0 và không chờ phí thì không giữ.
 */
export function buildSummaryRows(data: SourceData): SummaryRow[] {
  const rows = new Map<string, SummaryRow>();
  const rowOf = (day: string, orderId: string) => {
    const channel = data.channels.get(orderId);
    if (!channel) return undefined;
    const key = `${day}|${channel.source}|${channel.shopId ?? ''}`;
    let row = rows.get(key);
    if (!row) {
      const zero = new Decimal(0);
      row = { day, ...channel, revenue: zero, cashCollected: zero, platformFee: zero, paymentFee: zero, shippingFee: zero, cogs: zero, profit: zero, feesPending: false };
      rows.set(key, row);
    }
    return row;
  };

  for (const f of data.finance) {
    const row = rowOf(f.day, f.orderId);
    if (!row) continue;
    row.revenue = row.revenue.plus(f.revenue);
    row.cashCollected = row.cashCollected.plus(f.cashCollected).minus(f.refunded);
    if (f.invoiceNet !== 0) {
      row.cogs = row.cogs.plus((data.cogs.get(f.orderId) ?? new Decimal(0)).times(f.invoiceNet));
      row.platformFee = row.platformFee.plus(f.platformFee.times(f.invoiceNet));
      row.shippingFee = row.shippingFee.plus(f.shippingCost.times(f.invoiceNet));
    }
    if (row.source === 'marketplace' && f.invoiceNet > 0 && !f.settled) row.feesPending = true;
  }
  for (const p of data.paymentFees) {
    const row = rowOf(p.day, p.orderId);
    if (row) row.paymentFee = row.paymentFee.plus(p.fee);
  }

  return [...rows.values()]
    .map((row) => {
      for (const k of MONEY) row[k] = toDong(row[k]);
      row.profit = row.revenue.minus(row.cogs).minus(row.platformFee).minus(row.paymentFee).minus(row.shippingFee);
      return row;
    })
    .filter((row) => row.feesPending || MONEY.some((k) => !row[k].isZero()))
    .sort((a, b) => cmp(a.day, b.day) || cmp(a.source, b.source) || cmp(a.shopId ?? '', b.shopId ?? ''));
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
