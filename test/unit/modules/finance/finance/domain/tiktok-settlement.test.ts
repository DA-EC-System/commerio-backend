import { describe, expect, it } from 'vitest';
import {
  mapTikTokStatement,
  mapTikTokTransaction,
  SettlementMappingError,
  type TikTokStatement,
  type TikTokTransaction,
} from '#src/modules/finance/finance/domain/tiktok-settlement.ts';

// Ánh xạ giao dịch bảng kê OAS TikTok 202501 → dòng đối soát (plan #30 AC-1, A3): số có dấu của sàn cộng lại ra tiền
// về; lưu phí, vận chuyển theo dấu kế toán (dương = chi phí), điều chỉnh dương = sàn trả thêm.
const order = (over: Partial<TikTokTransaction> = {}): TikTokTransaction => ({
  id: 'tx-1',
  type: 'ORDER',
  order_id: 'so-1',
  revenue_amount: '200000',
  shipping_cost_amount: '-15000',
  fee_tax_amount: '-23000',
  fee_tax_breakdown: {
    fee: {
      platform_commission_amount: '-10000',
      transaction_fee_amount: '-6000',
      vn_fix_infrastructure_fee: '-3000',
      affiliate_commission_amount: '-2000',
      sfp_service_fee_amount: '-1000',
    },
    tax: { pit_amount: '-1000' },
  },
  adjustment_amount: '0',
  settlement_amount: '162000',
  ...over,
});

const plain = (fees: Record<string, { toFixed: (n: number) => string }>) =>
  Object.fromEntries(Object.entries(fees).map(([k, v]) => [k, v.toFixed(2)]));

describe('dòng đơn', () => {
  it('đổi dấu phí, vận chuyển sang chi phí dương; giữ doanh thu, tiền về', () => {
    const line = mapTikTokTransaction(order());
    expect(line.kind).toBe('order');
    expect(line.externalTransactionId).toBe('tx-1');
    expect(line.externalOrderId).toBe('so-1');
    expect(line.revenue.toFixed(2)).toBe('200000.00');
    expect(line.shippingCost.toFixed(2)).toBe('15000.00');
    expect(line.adjustment.toFixed(2)).toBe('0.00');
    expect(line.settlement.toFixed(2)).toBe('162000.00');
    expect(plain(line.fees)).toEqual({
      commission: '10000.00',
      transactionFee: '6000.00',
      infrastructureFee: '3000.00',
      affiliate: '2000.00',
      campaign: '1000.00',
      tax: '1000.00',
      other: '0.00',
    });
    expect(line.hasRefund).toBe(false);
  });

  it('mỗi trường vào đúng ô; nhiều trường cùng ô thì cộng; trường lạ vào other; thuế lạ vào tax', () => {
    const line = mapTikTokTransaction(
      order({
        fee_tax_breakdown: {
          fee: {
            platform_commission_amount: '-1000',
            dynamic_commission_amount: '-200',
            credit_card_handling_fee_amount: '-50',
            tap_shop_ads_commission: '-30',
            mall_service_fee_amount: '-7',
            refund_administration_fee_amount: '-5',
            fee_moi_cua_san: '-1',
          },
          tax: { local_vat_amount: '-100', thue_moi: '-3' },
        },
      }),
    );
    expect(plain(line.fees)).toEqual({
      commission: '1200.00',
      transactionFee: '50.00',
      infrastructureFee: '0.00',
      affiliate: '30.00',
      campaign: '7.00',
      tax: '103.00',
      other: '6.00',
    });
  });

  it('sàn hoàn phí (giá trị dương) thì ô phí âm', () => {
    const line = mapTikTokTransaction(
      order({
        fee_tax_breakdown: { fee: { platform_commission_amount: '500' } },
      }),
    );
    expect(line.fees.commission.toFixed(2)).toBe('-500.00');
  });

  it('bỏ trường tham khảo affiliate_commission_amount_before_pit', () => {
    const line = mapTikTokTransaction(
      order({
        fee_tax_breakdown: {
          fee: { affiliate_commission_amount_before_pit: '-9999' },
        },
      }),
    );
    expect(plain(line.fees)).toEqual({
      commission: '0.00',
      transactionFee: '0.00',
      infrastructureFee: '0.00',
      affiliate: '0.00',
      campaign: '0.00',
      tax: '0.00',
      other: '0.00',
    });
  });

  it('thiếu breakdown, thiếu trường tuỳ chọn hoặc chuỗi rỗng thì bằng 0', () => {
    const line = mapTikTokTransaction({
      id: 'tx-2',
      type: 'ORDER',
      order_id: 'so-2',
      revenue_amount: '1000',
      shipping_cost_amount: '',
      settlement_amount: '1000',
    });
    expect(line.shippingCost.toFixed(2)).toBe('0.00');
    expect(line.fees.other.toFixed(2)).toBe('0.00');
    expect(line.adjustment.toFixed(2)).toBe('0.00');
  });

  it('có hoàn khi refund_subtotal_before_discount_amount khác 0', () => {
    const line = mapTikTokTransaction(
      order({
        revenue_breakdown: { refund_subtotal_before_discount_amount: '-50000' },
      }),
    );
    expect(line.hasRefund).toBe(true);
  });

  it('đọc số lớn bằng decimal.js, không qua number', () => {
    const line = mapTikTokTransaction(
      order({
        revenue_amount: '9007199254740993',
        settlement_amount: '9007199254740993',
      }),
    );
    expect(line.revenue.toFixed(0)).toBe('9007199254740993');
  });

  it('giữ nguyên giao dịch gốc làm raw', () => {
    const tx = order();
    expect(mapTikTokTransaction(tx).raw).toBe(tx);
  });
});

describe('dòng điều chỉnh và giữ lại', () => {
  it('mã điều chỉnh → adjustment, đơn theo adjustment_order_id, điều chỉnh giữ dấu', () => {
    const line = mapTikTokTransaction({
      id: 'tx-3',
      type: 'PLATFORM_PENALTY',
      adjustment_id: 'adj-1',
      adjustment_order_id: 'so-9',
      adjustment_amount: '-20000',
      settlement_amount: '-20000',
    });
    expect(line.kind).toBe('adjustment');
    expect(line.externalOrderId).toBe('so-9');
    expect(line.revenue.toFixed(2)).toBe('0.00');
    expect(line.adjustment.toFixed(2)).toBe('-20000.00');
    expect(line.settlement.toFixed(2)).toBe('-20000.00');
  });

  it('điều chỉnh không gắn đơn → externalOrderId null', () => {
    const line = mapTikTokTransaction({
      id: 'tx-4',
      type: 'PLATFORM_REIMBURSEMENT',
      adjustment_amount: '5000',
      settlement_amount: '5000',
    });
    expect(line.externalOrderId).toBeNull();
  });

  it('RESERVE → reserve, đơn theo associated_order_id, điều chỉnh và tiền về = reserve_amount', () => {
    const line = mapTikTokTransaction({
      id: 'tx-5',
      type: 'RESERVE',
      reserve_id: 'r-1',
      associated_order_id: 'so-3',
      reserve_amount: '-7000',
    });
    expect(line.kind).toBe('reserve');
    expect(line.externalOrderId).toBe('so-3');
    expect(line.adjustment.toFixed(2)).toBe('-7000.00');
    expect(line.settlement.toFixed(2)).toBe('-7000.00');
  });
});

describe('lỗi ánh xạ', () => {
  it.each([
    ['tiền có phần lẻ khác 0', { revenue_amount: '123456.78' }, 'revenue_amount'],
    ['tiền không phải số', { settlement_amount: 'abc' }, 'settlement_amount'],
    [
      'phí không phải số',
      { fee_tax_breakdown: { fee: { platform_commission_amount: '1e3' } } },
      'fee_tax_breakdown.fee.platform_commission_amount',
    ],
    ['thiếu settlement_amount', { settlement_amount: undefined }, 'settlement_amount'],
    ['thiếu id', { id: '' }, 'id'],
    ['thiếu order_id ở dòng đơn', { order_id: undefined }, 'order_id'],
    ['tiền vượt numeric(18,2)', { revenue_amount: '10000000000000000' }, 'revenue_amount'],
  ])('%s → SettlementMappingError có tên trường', (_name, over, field) => {
    expect(() => mapTikTokTransaction(order(over as Partial<TikTokTransaction>))).toThrow(SettlementMappingError);
    try {
      mapTikTokTransaction(order(over as Partial<TikTokTransaction>));
    } catch (e) {
      expect((e as SettlementMappingError).field).toBe(field);
    }
  });

  it('chấp nhận phần lẻ bằng 0 ("1000.00")', () => {
    expect(mapTikTokTransaction(order({ revenue_amount: '200000.00' })).revenue.toFixed(2)).toBe('200000.00');
  });
});

describe('bảng kê', () => {
  it('đọc id, thời điểm (giây Unix), tiền về, trạng thái trả tiền', () => {
    const st = mapTikTokStatement({
      id: 'st-1',
      statement_time: 1760832000,
      settlement_amount: '162000',
      payment_status: 'PAID',
    });
    expect(st.externalStatementId).toBe('st-1');
    expect(st.statementTime.toISOString()).toBe('2025-10-19T00:00:00.000Z');
    expect(st.settlementAmount.toFixed(2)).toBe('162000.00');
    expect(st.paymentStatus).toBe('PAID');
  });

  it.each([
    ['thiếu id', { id: '' }, 'id'],
    ['tiền tệ khác VND', { currency: 'USD' }, 'currency'],
    ['thời điểm quá lớn', { statement_time: 1e15 }, 'statement_time'],
    ['thời điểm không phải số nguyên', { statement_time: '1760832000' }, 'statement_time'],
    ['thiếu trạng thái', { payment_status: undefined }, 'payment_status'],
    ['tiền có phần lẻ', { settlement_amount: '1.5' }, 'settlement_amount'],
  ])('%s → SettlementMappingError', (_n, over, field) => {
    const base = { id: 'st-1', statement_time: 1760832000, settlement_amount: '1', payment_status: 'PAID' };
    try {
      mapTikTokStatement({ ...base, ...over } as TikTokStatement);
      expect.unreachable();
    } catch (e) {
      expect((e as SettlementMappingError).field).toBe(field);
    }
  });
});
