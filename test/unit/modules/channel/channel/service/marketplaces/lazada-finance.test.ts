import { describe, expect, it, vi } from 'vitest';
import { createLazadaAdapter, lazadaLedgerKind, normalizeLazadaTxnId } from '#src/modules/channel/channel/service/marketplaces/lazada.ts';

const config = { appKey: 'k', appSecret: 's', redirectUrl: 'https://app/cb', apiUrl: 'https://api.test/rest', authUrl: 'https://auth.test' };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const query = (fn: ReturnType<typeof vi.fn>, n: number) => Object.fromEntries(new URL(String(fn.mock.calls[n]![0])).searchParams);
const row = (n: number) => ({
  transaction_number: `TX${n}`,
  order_no: '600000000000001',
  transaction_date: '2026-10-30',
  fee_name: 'Commission',
  transaction_type: 'Orders-Lazada Fees',
  amount: '-5160.00',
  WHT_amount: '0.00',
});

describe('Lazada: quyết toán (#117)', () => {
  it('lật trang theo offset tới khi trang ngắn hơn 500, đổi trường sang SettlementTxn', async () => {
    const full = Array.from({ length: 500 }, (_, i) => row(i));
    const fn = vi.fn().mockResolvedValueOnce(json({ code: '0', data: full })).mockResolvedValueOnce(json({ code: '0', data: [row(500)] }));
    const txns = await createLazadaAdapter(config, fn).getTransactions!('t', '2026-10-01', '2026-10-31');
    expect(txns).toHaveLength(501);
    expect(txns[0]).toEqual({
      txnId: 'TX0',
      externalOrderId: '600000000000001',
      date: '2026-10-30',
      feeName: 'Commission',
      feeCode: null,
      transactionType: 'Orders-Lazada Fees',
      amount: '-5160.00',
      withholding: '0.00',
      kind: 'fee_fixed',
    });
    expect(query(fn, 0)).toMatchObject({ start_time: '2026-10-01', end_time: '2026-10-31', limit: '500', offset: '0', access_token: 't' });
    expect(query(fn, 1).offset).toBe('500');
  });

  it('bỏ dòng không có mã giao dịch; dòng không gắn đơn có externalOrderId null', async () => {
    const fn = vi.fn().mockResolvedValueOnce(json({ code: '0', data: [{ ...row(1), order_no: '' }, { ...row(2), transaction_number: '' }] }));
    const txns = await createLazadaAdapter(config, fn).getTransactions!('t', '2026-10-01', '2026-10-31');
    expect(txns.map((x) => [x.txnId, x.externalOrderId])).toEqual([['TX1', null]]);
  });

  it('kỳ quyết toán: số dư cuối kỳ, đã trả hay chưa', async () => {
    const fn = vi.fn().mockResolvedValueOnce(
      json({ code: '0', data: [{ statement_number: 'VN2026W44', created_at: '2026-11-02', payout: '230000.00', closing_balance: '230000.00', paid: '0' }] }),
    );
    expect(await createLazadaAdapter(config, fn).getPayouts!('t', '2026-10-01')).toEqual([
      { statementNumber: 'VN2026W44', createdAt: '2026-11-02', payout: '230000.00', closingBalance: '230000.00', paid: false },
    ]);
    expect(query(fn, 0).created_after).toBe('2026-10-01');
  });
});

// Bảng chuyển từ finance (kindOfTransaction) sang adapter ở #203: cùng kết quả với dữ liệu Lazada cũ, khoản không
// nhận ra trả null thay vì 'adjustment' (finance tự ghi adjustment kèm tên phí).
describe('loại khoản của dòng quyết toán Lazada (adapter điền kind, #203)', () => {
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
    ['Phí lạ', 'Other', null],
  ])('%s (%s) → %s', (fee, type, kind) => {
    expect(lazadaLedgerKind(fee, type)).toBe(kind);
  });
});

describe('mã giao dịch Lazada (#250)', () => {
  it('giữ mã phí gốc fee_type (US-TI-06 dòng 2)', async () => {
    const fn = vi.fn().mockResolvedValueOnce(json({ code: '0', data: [{ ...row(1), fee_type: 'FT_COMMISSION' }] }));
    const txns = await createLazadaAdapter(config, fn).getTransactions!('t', '2026-10-01', '2026-10-31');
    expect(txns[0]!.feeCode).toBe('FT_COMMISSION');
  });

  it('getTransactions chuẩn hoá mã trước khi trả', async () => {
    const fn = vi.fn().mockResolvedValueOnce(json({ code: '0', data: [{ ...row(1), transaction_number: 'VN1234ABC- 77' }] }));
    const txns = await createLazadaAdapter(config, fn).getTransactions!('t', '2026-10-01', '2026-10-31');
    expect(txns[0]!.txnId).toBe('VN1234ABC-77');
  });

  it('bỏ khoảng trắng của dạng "Seller code- xxxxxxx" để so trùng được', () => {
    expect(normalizeLazadaTxnId('VN1234ABC- 9876543')).toBe('VN1234ABC-9876543');
    expect(normalizeLazadaTxnId(' VN1234ABC-9876543 ')).toBe('VN1234ABC-9876543');
    expect(normalizeLazadaTxnId(undefined)).toBe('');
  });
});
