// Luật khớp đối soát tiền sàn (Documents/21 T23–T25, D19; plan #30 A4, A5, lệch T23/T24 Thành duyệt 19/10).
import { Decimal } from 'decimal.js';
import { FEE_KEYS, type SettlementLineInput } from './tiktok-settlement.ts';

type MatchStatus = 'matched' | 'discrepancy' | 'refund_tagged';
type DiscrepancyReason = 'order_not_found' | 'revenue_mismatch' | 'formula_mismatch';
interface MatchResult {
  matchStatus: MatchStatus;
  discrepancyReason: DiscrepancyReason | null;
}

type Amounts = Pick<SettlementLineInput, 'revenue' | 'fees' | 'shippingCost' | 'adjustment' | 'settlement'>;

/** Tổng các ô phí. */
export function feeTotal(fees: SettlementLineInput['fees']): Decimal {
  return FEE_KEYS.reduce((sum, k) => sum.plus(fees[k]), new Decimal(0));
}

/** `doanh thu − phí − vận chuyển + điều chỉnh = tiền về`, đúng đến đồng (T23 c). */
export function formulaHolds(line: Amounts): boolean {
  return line.revenue.minus(feeTotal(line.fees)).minus(line.shippingCost).plus(line.adjustment).equals(line.settlement);
}

const ok = (matchStatus: MatchStatus): MatchResult => ({
  matchStatus,
  discrepancyReason: null,
});
const discrepancy = (discrepancyReason: DiscrepancyReason): MatchResult => ({
  matchStatus: 'discrepancy',
  discrepancyReason,
});

/**
 * Trạng thái của một dòng. `order` là đơn tìm theo (gian hàng, mã đơn sàn), `null` khi không thấy. Dòng đơn xét theo
 * thứ tự: không thấy đơn → công thức → có hoàn (không so doanh thu vì doanh thu đã trừ phần hoàn) → doanh thu = tổng
 * đơn. Dòng điều chỉnh, giữ lại chỉ kiểm công thức, không bắt buộc có đơn.
 */
export function matchLine(
  line: Amounts & Pick<SettlementLineInput, 'kind' | 'hasRefund'>,
  order: { total: Decimal } | null,
): MatchResult {
  if (line.kind !== 'order') return formulaHolds(line) ? ok('matched') : discrepancy('formula_mismatch');
  if (!order) return discrepancy('order_not_found');
  if (!formulaHolds(line)) return discrepancy('formula_mismatch');
  if (line.hasRefund || line.settlement.isNegative()) return ok('refund_tagged');
  if (!line.revenue.equals(order.total)) return discrepancy('revenue_mismatch');
  return ok('matched');
}

/** Dòng được một phiếu thu: không lệch, tiền về dương, bảng kê đã `PAID` (D19; dòng âm không sinh phiếu). */
export function needsReceipt(line: { matchStatus: MatchStatus; settlement: Decimal }, paymentStatus: string): boolean {
  return paymentStatus === 'PAID' && line.matchStatus !== 'discrepancy' && line.settlement.greaterThan(0);
}
