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
  feeCode: string | null;
  transactionType: string;
  amount: string;
  withholding: string;
  /** Loại khoản adapter sàn đã nhận ra; `null` thì ghi `adjustment` kèm tên phí làm lý do (#203). */
  kind: LedgerKind | null;
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
    // CEO hoặc công ty một người chốt được lệch của gian hàng mình soạn cấu hình phí (25 §11, #249)
    allowSelfApproval: true,
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
 * (`resolved_diff_base`). `orderCancelled`: đơn đã huỷ trong app. Trả `null` khi giữ nguyên.
 */
export function nextAfterSettlement(
  state: SettlementState,
  estimated: Decimal.Value,
  diff: Decimal.Value,
  base: Decimal.Value | null,
  t: Threshold,
  orderCancelled: boolean,
): { to: SettlementState; action: SettlementAction } | null {
  const allowed = allowedDiff(estimated, t);
  const over = (d: Decimal.Value) => new Decimal(d).abs().greaterThan(allowed);
  switch (state) {
    case 'none':
      // Chưa có kiện nào giao xong. Đơn đã huỷ mà sàn vẫn thu, trả tiền: lệch. Đơn còn đang giao (E139): quyết toán về
      // trước khi app thấy kiện giao, giữ nguyên, xét lại khi kiện giao xong (`markDelivered`).
      if (new Decimal(diff).isZero() || !orderCancelled) return null;
      return { to: 'mismatch', action: 'cancelled_charged' };
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

