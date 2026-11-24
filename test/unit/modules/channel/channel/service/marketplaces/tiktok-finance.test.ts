import { describe, expect, it } from 'vitest';
import type { TiktokClient } from '#src/modules/channel/channel/service/marketplaces/tiktok-client.ts';
import {
  tiktokAmount,
  tiktokFeeSample,
  tiktokFinanceMethods,
  tiktokStatementRows,
} from '#src/modules/channel/channel/service/marketplaces/tiktok-finance.ts';

// Quyết toán TikTok theo sao kê và mẫu phí (tiktok-quyet-toan-plan.md). Sandbox không quyết toán nên fixture dựng theo OAS
// Get Transactions by Statement 202501 (skill tts-openapi-guide, tra 21/11/2026), kể cả chỗ OAS lẫn dấu.

/** Giao dịch đơn theo ví dụ OAS: phí dương ("20"), tổng phí âm ("-30"), có trường tham khảo before_pit. */
const oasOrder = {
  id: 'T1',
  type: 'ORDER',
  order_id: 'O1',
  revenue_amount: '200',
  shipping_cost_amount: '-10',
  fee_tax_amount: '-30',
  settlement_amount: '130',
  revenue_breakdown: { subtotal_before_discount_amount: '220', seller_discount_amount: '20', refund_subtotal_before_discount_amount: '0' },
  supplementary_component: { customer_payment_amount: '190', platform_discount_amount: '10' },
  fee_tax_breakdown: {
    fee: {
      platform_commission_amount: '20',
      transaction_fee_amount: '-12',
      vn_fix_infrastructure_fee: '3',
      mall_service_fee_amount: '4',
      voucher_xtra_service_fee_amount: '10',
      affiliate_commission_amount: '5',
      affiliate_commission_amount_before_pit: '6',
      epr_pob_service_fee_amount: '0',
      some_new_fee_amount: '1',
    },
    tax: { local_vat_amount: '2', pit_amount: '-1', gst_amount: '0' },
  },
};

describe('tiktokStatementRows', () => {
  it('đơn: doanh thu, vận chuyển giữ dấu; phí, thuế khấu trừ luôn âm dù OAS ghi dương hay âm; trường tham khảo bỏ; trường lạ kind null', () => {
    const rows = tiktokStatementRows('S1', '2026-11-20', oasOrder);
    const by = Object.fromEntries(rows.map((r) => [r.feeName, [r.amount, r.kind]]));
    expect(by).toEqual({
      revenue_amount: ['200', 'revenue'],
      shipping_cost_amount: ['-10', 'shipping_cost'],
      platform_commission_amount: ['-20', 'fee_fixed'],
      transaction_fee_amount: ['-12', 'fee_transaction'],
      vn_fix_infrastructure_fee: ['-3', 'fee_service'],
      mall_service_fee_amount: ['-4', 'fee_service'],
      voucher_xtra_service_fee_amount: ['-10', 'fee_optional'],
      affiliate_commission_amount: ['-5', 'fee_optional'],
      some_new_fee_amount: ['-1', null],
      'tax.local_vat_amount': ['-2', 'withholding_tax'],
      'tax.pit_amount': ['-1', 'withholding_tax'],
    });
    expect(rows.every((r) => r.externalOrderId === 'O1' && r.date === '2026-11-20' && r.withholding === '0')).toBe(true);
    expect(rows[0]!.txnId).toBe('S1:T1:revenue_amount');
    expect(new Set(rows.map((r) => r.txnId)).size).toBe(rows.length);
  });

  it('vận chuyển giữ dấu của sàn: dương (khách trả, sàn trợ giá lớn hơn phí thực) là shipping_income, âm là shipping_cost', () => {
    const ship = (v: string) => tiktokStatementRows('S', 'd', { id: 'T', type: 'ORDER', order_id: 'O', shipping_cost_amount: v });
    expect(ship('15.5')).toMatchObject([{ feeName: 'shipping_cost_amount', amount: '15.5', kind: 'shipping_income' }]);
    expect(ship('-22')).toMatchObject([{ feeName: 'shipping_cost_amount', amount: '-22', kind: 'shipping_cost' }]);
    expect(ship('0')).toEqual([]);
  });

  it('điều chỉnh theo type (phạt, hoa hồng, quảng cáo, loại lạ); giữ tiền dự trữ kind null; số 0 không ghi', () => {
    expect(tiktokStatementRows('S', 'd', { id: 'A1', type: 'PLATFORM_PENALTY', adjustment_order_id: 'O9', adjustment_amount: '-50' })).toMatchObject([
      { amount: '-50', kind: 'penalty', externalOrderId: 'O9' },
    ]);
    expect(tiktokStatementRows('S', 'd', { id: 'A2', type: 'PLATFORM_COMMISSION_COMPENSATION', adjustment_amount: '5' })[0]!.kind).toBe('fee_fixed');
    expect(tiktokStatementRows('S', 'd', { id: 'A3', type: 'GMV_PAYMENT_FOR_ADS', adjustment_amount: '-7' })[0]!.kind).toBe('ads');
    expect(tiktokStatementRows('S', 'd', { id: 'A4', type: 'CHARGE_BACK', adjustment_amount: '-7' })[0]!.kind).toBeNull();
    expect(tiktokStatementRows('S', 'd', { id: 'R1', type: 'RESERVE', associated_order_id: 'O1', reserve_amount: '-15' })).toMatchObject([
      { amount: '-15', kind: null, externalOrderId: 'O1' },
    ]);
    expect(tiktokStatementRows('S', 'd', { id: 'A5', type: 'PLATFORM_PENALTY', adjustment_amount: '0' })).toEqual([]);
    expect(tiktokStatementRows('S', 'd', { type: 'ORDER' })).toEqual([]);
  });

  it('số tiền sai dạng: invalid_amount kèm trường và giao dịch', () => {
    let err: unknown;
    try {
      tiktokStatementRows('S', 'd', { ...oasOrder, revenue_amount: '1,600.02' });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ kind: 'rejected', platformCode: 'invalid_amount', platformMessage: expect.stringContaining('revenue_amount, giao dịch T1') });
    expect(() => tiktokAmount('NaN', 'x')).toThrow();
    expect(tiktokAmount(undefined, 'x').toString()).toBe('0');
    expect(tiktokAmount(12, 'x').toString()).toBe('12');
  });
});

describe('tiktokFeeSample', () => {
  it('cơ sở hoa hồng = trước giảm − giảm của người bán; cơ sở phí giao dịch = khách trả + giảm của nền tảng; phí theo độ lớn', () => {
    expect(tiktokFeeSample(oasOrder, '2026-11-20', false)).toEqual({
      externalOrderId: 'O1',
      date: '2026-11-20',
      commissionBase: '200',
      transactionBase: '200',
      itemCount: null,
      fees: { fee_fixed: '20', fee_transaction: '12', fee_service: '7', fee_optional: '15', withholding_tax: '3' },
      estimated: false,
    });
  });

  it('đơn có hoàn tiền, điều chỉnh, cơ sở không dương thì không lấy; không có supplementary thì transactionBase null', () => {
    expect(tiktokFeeSample({ ...oasOrder, revenue_breakdown: { ...oasOrder.revenue_breakdown, refund_subtotal_before_discount_amount: '50' } }, 'd', false)).toBeNull();
    expect(tiktokFeeSample({ id: 'A', type: 'PLATFORM_PENALTY', adjustment_order_id: 'O' }, 'd', false)).toBeNull();
    expect(tiktokFeeSample({ ...oasOrder, revenue_breakdown: { subtotal_before_discount_amount: '10', seller_discount_amount: '10' } }, 'd', false)).toBeNull();
    const noSup: Record<string, unknown> = { ...oasOrder };
    delete noSup.supplementary_component;
    expect(tiktokFeeSample(noSup, 'd', true)).toMatchObject({ transactionBase: null, estimated: true });
  });
});

/** Client giả: trả theo path, ghi lại query. */
function fakeClient(routes: Record<string, (q: Record<string, unknown>) => unknown>) {
  const calls: { path: string; query: Record<string, unknown> }[] = [];
  const client = {
    async call(_m: string, path: string, opts: { query?: Record<string, unknown> } = {}) {
      const query = opts.query ?? {};
      calls.push({ path, query });
      const route = Object.entries(routes).find(([p]) => path === p);
      if (!route) throw new Error(`không có route ${path}`);
      return route[1](query);
    },
  } as unknown as TiktokClient;
  return { client, calls };
}

describe('tiktokFinanceMethods', () => {
  it('getTransactions: sao kê trong khoảng ngày giờ VN (lật trang), giao dịch từng sao kê (lật trang), ngày là ngày sao kê', async () => {
    // 2026-11-20 00:00 +07 = 1795107600.
    const { client, calls } = fakeClient({
      '/finance/202309/statements': (q) =>
        q.page_token ? { statements: [{ id: 'S2', statement_time: 1795194000 }] } : { statements: [{ id: 'S1', statement_time: 1795107600 }], next_page_token: 'p2' },
      '/finance/202501/statements/S1/statement_transactions': (q) =>
        q.page_token ? { transactions: [{ ...oasOrder, id: 'T2', order_id: 'O2' }] } : { transactions: [oasOrder], next_page_token: 'n' },
      '/finance/202501/statements/S2/statement_transactions': () => ({ transactions: [] }),
    });
    const rows = await tiktokFinanceMethods(client).getTransactions!('tok', '2026-11-20', '2026-11-21');
    expect(new Set(rows.map((r) => r.externalOrderId))).toEqual(new Set(['O1', 'O2']));
    expect(rows.every((r) => r.date === '2026-11-20')).toBe(true);
    expect(calls[0]!.query).toMatchObject({ sort_field: 'statement_time', statement_time_ge: 1795107600, statement_time_lt: 1795107600 + 2 * 86_400, page_size: 100 });
    expect(calls.find((c) => c.path.includes('S1'))!.query).toMatchObject({ sort_field: 'order_create_time', page_size: 100 });
  });

  it('feeSamples: đơn đã quyết toán mới nhất trước tới đủ limit; thiếu thì bù số ước tính (estimated) của Get Unsettled Transactions', async () => {
    const { client, calls } = fakeClient({
      '/finance/202309/statements': () => ({ statements: [{ id: 'S1', statement_time: 1795107600 }] }),
      '/finance/202501/statements/S1/statement_transactions': () => ({ transactions: [oasOrder] }),
      '/finance/202507/orders/unsettled': () => ({
        transactions: [{ ...oasOrder, id: 'U1', order_id: 'O7', order_delivery_time: 1795194000 }, { ...oasOrder, id: 'U2', order_id: 'O8' }],
      }),
    });
    const samples = await tiktokFinanceMethods(client).feeSamples!('tok', { limit: 2, since: '2026-10-22' });
    expect(samples.map((s) => [s.externalOrderId, s.estimated])).toEqual([
      ['O1', false],
      ['O7', true],
    ]);
    expect(samples[1]!.date).toBe('2026-11-21');
    expect(calls.find((c) => c.path === '/finance/202309/statements')!.query).toMatchObject({ sort_order: 'DESC' });
    expect(calls.find((c) => c.path === '/finance/202507/orders/unsettled')!.query).toMatchObject({ sort_field: 'order_create_time', search_time_ge: 1792602000 });
  });

  it('feeSamples: đủ mẫu đã quyết toán thì không gọi Get Unsettled Transactions', async () => {
    const { client, calls } = fakeClient({
      '/finance/202309/statements': () => ({ statements: [{ id: 'S1', statement_time: 1795107600 }] }),
      '/finance/202501/statements/S1/statement_transactions': () => ({ transactions: [oasOrder, { ...oasOrder, id: 'T2', order_id: 'O2' }] }),
    });
    expect(await tiktokFinanceMethods(client).feeSamples!('tok', { limit: 1, since: '2026-10-22' })).toHaveLength(1);
    expect(calls.some((c) => c.path.includes('unsettled'))).toBe(false);
  });
});
