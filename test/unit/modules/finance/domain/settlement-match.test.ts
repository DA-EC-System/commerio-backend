import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { formulaHolds, matchLine, needsReceipt } from '#src/modules/finance/domain/settlement-match.ts';
import { mapTikTokTransaction } from '#src/modules/finance/domain/tiktok-settlement.ts';

// Luật khớp đối soát (plan #30 AC-2, A4, A5; Documents/21 T23–T25, D19, lệch đã duyệt 19/10).
const orderTx = {
  id: 'tx-1',
  type: 'ORDER',
  order_id: 'so-1',
  revenue_amount: '200000',
  shipping_cost_amount: '-15000',
  fee_tax_breakdown: {
    fee: {
      platform_commission_amount: '-10000',
      transaction_fee_amount: '-12000',
    },
    tax: { pit_amount: '-1000' },
  },
  settlement_amount: '162000',
};
const line = (over: Record<string, unknown> = {}) => mapTikTokTransaction({ ...orderTx, ...over });
const order = (total: Decimal.Value) => ({ total: new Decimal(total) });

describe('công thức doanh thu − phí − vận chuyển + điều chỉnh = tiền về', () => {
  it('cân thì đúng', () => {
    expect(formulaHolds(line())).toBe(true);
  });

  it('lệch một đồng thì sai', () => {
    expect(formulaHolds(line({ settlement_amount: '162001' }))).toBe(false);
  });

  it('breakdown thiếu một khoản (tổng fee_tax khác Σ breakdown) thì sai', () => {
    expect(
      formulaHolds(
        line({
          fee_tax_breakdown: { fee: { platform_commission_amount: '-10000' } },
        }),
      ),
    ).toBe(false);
  });

  it('ví dụ giao dịch của OAS (200, −70, −30, 170 → 130) lệch theo quy ước dấu A3 (rủi ro R1)', () => {
    const oas = mapTikTokTransaction({
      id: 'oas',
      type: 'ORDER',
      order_id: 'x',
      revenue_amount: '200',
      shipping_cost_amount: '-70',
      fee_tax_breakdown: { fee: { platform_commission_amount: '-30' } },
      adjustment_amount: '170',
      settlement_amount: '130',
    });
    expect(formulaHolds(oas)).toBe(false);
  });
});

describe('dòng đơn: thứ tự xét A5', () => {
  it.each([
    ['khớp đủ', line(), order(200000), 'matched', null],
    ['không thấy đơn', line(), null, 'discrepancy', 'order_not_found'],
    [
      'không thấy đơn đứng trước công thức lệch',
      line({ settlement_amount: '1' }),
      null,
      'discrepancy',
      'order_not_found',
    ],
    ['công thức lệch', line({ settlement_amount: '162001' }), order(200000), 'discrepancy', 'formula_mismatch'],
    [
      'công thức lệch đứng trước hoàn',
      line({
        settlement_amount: '1',
        revenue_breakdown: { refund_subtotal_before_discount_amount: '-5' },
      }),
      order(200000),
      'discrepancy',
      'formula_mismatch',
    ],
    [
      'có hoàn theo refund_subtotal → nhãn hoàn, không so doanh thu',
      line({
        revenue_breakdown: { refund_subtotal_before_discount_amount: '-50000' },
      }),
      order(250000),
      'refund_tagged',
      null,
    ],
    [
      'tiền về âm → nhãn hoàn',
      line({
        revenue_amount: '0',
        shipping_cost_amount: '0',
        fee_tax_breakdown: {},
        settlement_amount: '-15000',
        adjustment_amount: '-15000',
      }),
      order(1),
      'refund_tagged',
      null,
    ],
    ['doanh thu khác tổng đơn', line(), order(210000), 'discrepancy', 'revenue_mismatch'],
  ] as const)('%s', (_name, l, o, status, reason) => {
    expect(matchLine(l, o)).toEqual({
      matchStatus: status,
      discrepancyReason: reason,
    });
  });
});

describe('dòng điều chỉnh, giữ lại: chỉ kiểm công thức (lệch T23 đã duyệt)', () => {
  const adj = mapTikTokTransaction({
    id: 'a',
    type: 'PLATFORM_COMPENSATION',
    adjustment_amount: '5000',
    settlement_amount: '5000',
  });
  it('không thấy đơn vẫn matched', () => {
    expect(matchLine(adj, null)).toEqual({
      matchStatus: 'matched',
      discrepancyReason: null,
    });
  });
  it('công thức lệch → formula_mismatch', () => {
    const bad = mapTikTokTransaction({
      id: 'b',
      type: 'PLATFORM_PENALTY',
      adjustment_amount: '-5000',
      settlement_amount: '-4000',
    });
    expect(matchLine(bad, order(1))).toEqual({
      matchStatus: 'discrepancy',
      discrepancyReason: 'formula_mismatch',
    });
  });
  it('giữ lại âm vẫn matched', () => {
    const res = mapTikTokTransaction({
      id: 'r',
      type: 'RESERVE',
      reserve_amount: '-7000',
    });
    expect(matchLine(res, null)).toEqual({
      matchStatus: 'matched',
      discrepancyReason: null,
    });
  });
});

describe('phiếu thu theo dòng (A4, D19)', () => {
  it.each([
    ['matched, dương, PAID', 'matched', '1000', 'PAID', true],
    ['refund_tagged, dương, PAID', 'refund_tagged', '1000', 'PAID', true],
    ['discrepancy', 'discrepancy', '1000', 'PAID', false],
    ['tiền về 0', 'matched', '0', 'PAID', false],
    ['tiền về âm', 'matched', '-1', 'PAID', false],
    ['bảng kê chưa PAID', 'matched', '1000', 'PROCESSING', false],
  ] as const)('%s', (_name, matchStatus, settlement, paymentStatus, expected) => {
    expect(needsReceipt({ matchStatus, settlement: new Decimal(settlement) }, paymentStatus)).toBe(expected);
  });
});
