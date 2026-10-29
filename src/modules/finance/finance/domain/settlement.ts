// Trạng thái tiền của đơn và đối soát quyết toán (#117; Documents/21 §21.2, §21.3; 25 §10.3). Thuần.
import { Decimal } from 'decimal.js';
import { defineMachine } from '../../../core/index.ts';
import type { ConfigPayload } from './config-version.ts';
import type { LedgerKind } from './ledger.ts';

/** Một khoản tiền sàn ghi theo đơn (cùng hình `SettlementTxn` của channel; finance không import channel). */
export interface PlatformTxn {
  txnId: string;
  externalOrderId: string | null;
  date: string;
  feeName: string;
  transactionType: string;
  amount: string;
  withholding: string;
}

/** Một kỳ quyết toán của sàn (cùng hình `Payout` của channel). */
export interface PlatformPayout {
  statementNumber: string;
  createdAt: string;
  payout: string;
  closingBalance: string;
  paid: boolean;
}

export const SETTLEMENT_STATES = ['none', 'pending', 'settled', 'mismatch', 'resolved'] as const;
export type SettlementState = (typeof SETTLEMENT_STATES)[number];
export type SettlementAction = 'first_delivered' | 'settle' | 'mismatch' | 'late_adjust' | 'cancelled_charged' | 'resolve' | 'new_adjust';

export interface SettlementRecord {
  /** Người soạn cấu hình phí đang áp cho gian hàng: người chốt lệch phải khác (§21.2). */
  createdBy: string | null;
}

/** Bảng chuyển §21.2. Chỉ `resolve` do người làm; còn lại hệ thống, sau lô quyết toán hoặc khi kiện giao. */
export const settlementMachine = defineMachine<SettlementState, SettlementAction, SettlementRecord>([
  { from: 'none', to: 'pending', action: 'first_delivered', label: 'Kiện đầu tiên giao xong', system: true },
  { from: 'pending', to: 'settled', action: 'settle', label: 'Quyết toán khớp', system: true },
  { from: 'pending', to: 'mismatch', action: 'mismatch', label: 'Quyết toán lệch', system: true },
  { from: 'settled', to: 'mismatch', action: 'late_adjust', label: 'Điều chỉnh muộn', system: true },
  { from: 'none', to: 'mismatch', action: 'cancelled_charged', label: 'Sàn thu tiền đơn chưa giao', system: true },
  {
    from: 'mismatch',
    to: 'resolved',
    action: 'resolve',
    label: 'Chốt lệch',
    permission: 'finance.settlement.resolve',
    needsSecondPerson: true,
    needsReason: true,
  },
  { from: 'resolved', to: 'mismatch', action: 'new_adjust', label: 'Lệch mới sau khi chốt', system: true },
]);

export type Threshold = ConfigPayload<'mismatch_threshold'>;

/** Không có phiên bản ngưỡng lệch thì lệch một đồng cũng là lệch, mọi lệch cần CEO duyệt. */
export const NO_THRESHOLD: Threshold = { abs: 0, pct: 0, resolveLimit: 0 };

/** Lệch cho phép: lớn hơn giữa số tuyệt đối và phần trăm của số ước tính. */
export function allowedDiff(estimated: Decimal.Value, t: Threshold): Decimal {
  return Decimal.max(new Decimal(t.abs), new Decimal(estimated).abs().times(t.pct).div(100));
}

/**
 * Bước kế của trạng thái tiền sau một lô quyết toán (25 §10.3). `diff` = thực tế − ước tính; `base` là lệch lúc chốt
 * (`resolved_diff_base`). Trả `null` khi giữ nguyên.
 */
export function nextAfterSettlement(
  state: SettlementState,
  estimated: Decimal.Value,
  diff: Decimal.Value,
  base: Decimal.Value | null,
  t: Threshold,
): { to: SettlementState; action: SettlementAction } | null {
  const allowed = allowedDiff(estimated, t);
  const over = (d: Decimal.Value) => new Decimal(d).abs().greaterThan(allowed);
  switch (state) {
    case 'none':
      // Sàn thu, trả tiền cho đơn chưa có kiện nào giao (đơn đã huỷ mà sàn vẫn thu phí).
      return new Decimal(diff).isZero() ? null : { to: 'mismatch', action: 'cancelled_charged' };
    case 'pending':
      return over(diff) ? { to: 'mismatch', action: 'mismatch' } : { to: 'settled', action: 'settle' };
    case 'settled':
      return over(diff) ? { to: 'mismatch', action: 'late_adjust' } : null;
    case 'resolved':
      return over(new Decimal(diff).minus(base ?? 0)) ? { to: 'mismatch', action: 'new_adjust' } : null;
    case 'mismatch':
      return null;
  }
}

/** Chốt lệch vượt hạn mức tự chốt cần CEO duyệt trước (§21.2). */
export function needsCeoApproval(diff: Decimal.Value, base: Decimal.Value | null, t: Threshold): boolean {
  return new Decimal(diff).minus(base ?? 0).abs().greaterThan(t.resolveLimit);
}

/**
 * Loại khoản trong sổ của một dòng quyết toán Lazada (lazada.md §7.6). Theo tên phí và loại giao dịch; chưa nhận ra thì
 * `adjustment` kèm tên phí làm lý do. Bảng này dựng theo tài liệu và sàn giả lập #115: đối chiếu khi có dữ liệu thật.
 */
export function kindOfTransaction(feeName: string, transactionType: string): LedgerKind {
  const f = feeName.toLowerCase();
  const t = transactionType.toLowerCase();
  if (t.includes('payout') || t.includes('withdraw')) return 'withdrawal';
  if (f.startsWith('reversal item price') || f.includes('refund')) return 'customer_refund';
  if (f.includes('item price credit')) return 'revenue';
  if (f.includes('commission')) return 'fee_fixed';
  if (f.includes('payment fee')) return 'fee_transaction';
  if (f.includes('paid by customer')) return 'shipping_income';
  if (f.includes('shipping fee')) return 'shipping_cost';
  if (f.includes('handling fee') || f.includes('service fee') || f.includes('free shipping max') || f.includes('lazcoins')) {
    return 'fee_service';
  }
  if (t.includes('marketing') || f.includes('sponsored')) return 'ads';
  if (f.includes('lost') || f.includes('damaged') || f.includes('compensation') || f.includes('claim')) return 'lost_compensation';
  if (f.includes('penalty')) return 'penalty';
  if (f.includes('subsidy') || f.includes('platform voucher')) return 'platform_subsidy';
  return 'adjustment';
}
