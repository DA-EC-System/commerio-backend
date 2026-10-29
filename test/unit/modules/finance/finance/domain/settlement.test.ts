import { describe, expect, it } from 'vitest';
import { assertTransition } from '#src/modules/core/index.ts';
import { AppError } from '#src/shared/errors/app-error.ts';
import {
  allowedDiff,
  kindOfTransaction,
  needsCeoApproval,
  nextAfterSettlement,
  NO_THRESHOLD,
  settlementMachine,
} from '#src/modules/finance/finance/domain/settlement.ts';

const t = { abs: 5000, pct: 1, resolveLimit: 50000 };

describe('loại khoản của dòng quyết toán Lazada', () => {
  it.each([
    ['Item Price Credit', 'Orders-Sales', 'revenue'],
    ['Commission', 'Orders-Lazada Fees', 'fee_fixed'],
    ['Reversal Commission', 'Refunds-Claims', 'fee_fixed'],
    ['Payment Fee', 'Orders-Lazada Fees', 'fee_transaction'],
    ['Shipping Fee (Paid By Customer)', 'Orders-Logistics', 'shipping_income'],
    ['Shipping Fee Charged by Lazada', 'Orders-Logistics', 'shipping_cost'],
    ['Free Shipping Max Fee', 'Orders-Lazada Fees', 'fee_service'],
    ['Sponsored Discovery - Top up', 'Marketing Fees', 'ads'],
    ['Reversal Item Price', 'Refunds-Claims', 'customer_refund'],
    ['Lost Claim', 'Refunds-Claims', 'lost_compensation'],
    ['Seller Payout', 'Payout', 'withdrawal'],
    ['Phí lạ', 'Other', 'adjustment'],
  ])('%s (%s) → %s', (fee, type, kind) => {
    expect(kindOfTransaction(fee, type)).toBe(kind);
  });
});

describe('ngưỡng lệch', () => {
  it('lấy lớn hơn giữa số tuyệt đối và phần trăm của số ước tính', () => {
    expect(allowedDiff(100_000, t).toNumber()).toBe(5000);
    expect(allowedDiff(1_000_000, t).toNumber()).toBe(10_000);
    expect(allowedDiff(-1_000_000, t).toNumber()).toBe(10_000);
  });

  it('không có cấu hình ngưỡng thì lệch một đồng là lệch', () => {
    expect(nextAfterSettlement('pending', 246070, 1, null, NO_THRESHOLD)).toEqual({ to: 'mismatch', action: 'mismatch' });
  });
});

describe('trạng thái tiền sau lô quyết toán (§21.2)', () => {
  it('pending: trong ngưỡng thì settled, quá thì mismatch', () => {
    expect(nextAfterSettlement('pending', 246070, -4000, null, t)).toEqual({ to: 'settled', action: 'settle' });
    expect(nextAfterSettlement('pending', 246070, -15320, null, t)).toEqual({ to: 'mismatch', action: 'mismatch' });
  });

  it('settled: điều chỉnh muộn quá ngưỡng thì mismatch, trong ngưỡng thì giữ', () => {
    expect(nextAfterSettlement('settled', 246070, -9000, null, t)).toEqual({ to: 'mismatch', action: 'late_adjust' });
    expect(nextAfterSettlement('settled', 246070, -1000, null, t)).toBeNull();
  });

  it('none: sàn thu tiền đơn chưa giao thì mismatch (cancelled_charged)', () => {
    expect(nextAfterSettlement('none', 0, -3000, null, t)).toEqual({ to: 'mismatch', action: 'cancelled_charged' });
    expect(nextAfterSettlement('none', 0, 0, null, t)).toBeNull();
  });

  it('resolved: lệch mới tính từ mốc lúc chốt', () => {
    expect(nextAfterSettlement('resolved', 246070, -15320, -15320, t)).toBeNull();
    expect(nextAfterSettlement('resolved', 246070, -25320, -15320, t)).toEqual({ to: 'mismatch', action: 'new_adjust' });
  });

  it('mismatch giữ nguyên tới khi người chốt', () => {
    expect(nextAfterSettlement('mismatch', 246070, 0, null, t)).toBeNull();
  });
});

describe('chốt lệch', () => {
  const actor = (accountId: string) => ({ accountId, permissions: ['finance.settlement.resolve'], enabledModules: ['finance'] });
  const code = (fn: () => unknown) => {
    try {
      fn();
      return 'ok';
    } catch (err) {
      return err instanceof AppError ? err.code : String(err);
    }
  };

  it('người chốt khác người soạn cấu hình phí, bắt buộc lý do', () => {
    expect(assertTransition(settlementMachine, 'mismatch', 'resolve', { actor: actor('admin'), record: { createdBy: 'tac-gia' }, reason: 'ok' }).to).toBe(
      'resolved',
    );
    expect(code(() => assertTransition(settlementMachine, 'mismatch', 'resolve', { actor: actor('tac-gia'), record: { createdBy: 'tac-gia' }, reason: 'ok' }))).toBe(
      'second_person_required',
    );
    expect(code(() => assertTransition(settlementMachine, 'mismatch', 'resolve', { actor: actor('admin'), record: { createdBy: 'tac-gia' } }))).toBe(
      'reason_required',
    );
  });

  it('lệch vượt hạn mức tự chốt (tính từ mốc lúc chốt trước) thì cần CEO duyệt', () => {
    expect(needsCeoApproval(-15320, null, t)).toBe(false);
    expect(needsCeoApproval(-60000, null, t)).toBe(true);
    expect(needsCeoApproval(-60000, -20000, t)).toBe(false);
  });

  it('các bước của hệ thống, người dùng gọi thì invalid_transition', () => {
    expect(code(() => assertTransition(settlementMachine, 'pending', 'settle', { actor: actor('admin') }))).toBe('invalid_transition');
  });
});
