import { describe, expect, it, vi } from 'vitest';
import { createLazadaAdapter } from '#src/modules/channel/channel/service/marketplaces/lazada.ts';

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
      transactionType: 'Orders-Lazada Fees',
      amount: '-5160.00',
      withholding: '0.00',
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
