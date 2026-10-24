import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { buildSummaryRows, type SourceData } from '#src/modules/insight/report/domain/summary.ts';

const d = (n: number | string) => new Decimal(n);
const SHOP_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const SHOP_B = 'aaaaaaaa-0000-4000-8000-000000000002';

function financeRow(day: string, orderId: string, over: Partial<SourceData['finance'][number]> = {}) {
  return {
    day,
    orderId,
    revenue: d(0),
    cashCollected: d(0),
    refunded: d(0),
    invoiceNet: 0,
    platformFee: d(0),
    shippingCost: d(0),
    settled: false,
    ...over,
  };
}

function data(over: Partial<SourceData>): SourceData {
  return { finance: [], paymentFees: [], cogs: new Map(), channels: new Map(), ...over };
}

/** Dòng ra dạng chuỗi để so dễ đọc. */
const plain = (rows: ReturnType<typeof buildSummaryRows>) =>
  rows.map((r) => ({
    day: r.day,
    source: r.source,
    shopId: r.shopId,
    revenue: r.revenue.toString(),
    cashCollected: r.cashCollected.toString(),
    platformFee: r.platformFee.toString(),
    paymentFee: r.paymentFee.toString(),
    shippingFee: r.shippingFee.toString(),
    cogs: r.cogs.toString(),
    profit: r.profit.toString(),
    feesPending: r.feesPending,
  }));

describe('buildSummaryRows (plan #29 A1, A2, A12, AC-12, AC-16, AC-17)', () => {
  it('gộp theo (ngày, nguồn, gian hàng); lãi = doanh thu − giá vốn − phí sàn − phí cổng − vận chuyển', () => {
    const rows = buildSummaryRows(
      data({
        finance: [
          financeRow('2026-10-18', 'o1', { revenue: d(300000), invoiceNet: 1, platformFee: d(15000), shippingCost: d(20000), settled: true }),
          financeRow('2026-10-18', 'o2', { revenue: d(100000), invoiceNet: 1, cashCollected: d(100000) }),
          financeRow('2026-10-18', 'o3', { revenue: d(50000), invoiceNet: 1 }),
        ],
        paymentFees: [{ day: '2026-10-18', orderId: 'o2', fee: d(1100) }],
        cogs: new Map([
          ['o1', d(200000)],
          ['o2', d(60000)],
          ['o3', d(10000)],
        ]),
        channels: new Map([
          ['o1', { source: 'marketplace', shopId: SHOP_A }],
          ['o2', { source: 'manual', shopId: null }],
          ['o3', { source: 'manual', shopId: null }],
        ]),
      }),
    );
    expect(plain(rows)).toEqual([
      {
        day: '2026-10-18',
        source: 'manual',
        shopId: null,
        revenue: '150000',
        cashCollected: '100000',
        platformFee: '0',
        paymentFee: '1100',
        shippingFee: '0',
        cogs: '70000',
        profit: '78900',
        feesPending: false,
      },
      {
        day: '2026-10-18',
        source: 'marketplace',
        shopId: SHOP_A,
        revenue: '300000',
        cashCollected: '0',
        platformFee: '15000',
        paymentFee: '0',
        shippingFee: '20000',
        cogs: '200000',
        profit: '65000',
        feesPending: false,
      },
    ]);
  });

  it('giá vốn, phí sàn, vận chuyển nhân hệ số hoá đơn ròng: ngày đảo mang số âm, ngày chỉ có phiếu thu không mang', () => {
    const rows = buildSummaryRows(
      data({
        finance: [
          financeRow('2026-10-20', 'o1', { revenue: d(-300000), invoiceNet: -1, platformFee: d(15000), shippingCost: d(20000), settled: true }),
          financeRow('2026-10-21', 'o1', { cashCollected: d(300000) }),
        ],
        cogs: new Map([['o1', d(200000)]]),
        channels: new Map([['o1', { source: 'marketplace', shopId: SHOP_A }]]),
      }),
    );
    expect(plain(rows).map((r) => [r.day, r.revenue, r.cogs, r.platformFee, r.shippingFee, r.profit, r.cashCollected])).toEqual([
      ['2026-10-20', '-300000', '-200000', '-15000', '-20000', '-65000', '0'],
      ['2026-10-21', '0', '0', '0', '0', '0', '300000'],
    ]);
  });

  it('tiền đã thu = phiếu thu − hoàn tiền khách (A12)', () => {
    const rows = buildSummaryRows(
      data({
        finance: [financeRow('2026-10-18', 'o1', { cashCollected: d(100000), refunded: d(40000) })],
        channels: new Map([['o1', { source: 'inbox', shopId: null }]]),
      }),
    );
    expect(plain(rows)[0]!.cashCollected).toBe('60000');
  });

  it('phí sàn chờ đối soát chỉ với đơn sàn có hoá đơn ròng dương chưa có dòng đối soát', () => {
    const rows = buildSummaryRows(
      data({
        finance: [
          financeRow('2026-10-18', 'o1', { revenue: d(1), invoiceNet: 1 }),
          financeRow('2026-10-18', 'o2', { revenue: d(1), invoiceNet: 1 }),
          financeRow('2026-10-19', 'o3', { revenue: d(-1), invoiceNet: -1 }),
        ],
        channels: new Map([
          ['o1', { source: 'marketplace', shopId: SHOP_A }],
          ['o2', { source: 'manual', shopId: null }],
          ['o3', { source: 'marketplace', shopId: SHOP_B }],
        ]),
      }),
    );
    expect(plain(rows).map((r) => [r.day, r.source, r.feesPending])).toEqual([
      ['2026-10-18', 'manual', false],
      ['2026-10-18', 'marketplace', true],
      ['2026-10-19', 'marketplace', false],
    ]);
  });

  it('làm tròn từng thành phần một lần trên dòng, nửa lên, số âm ra xa 0; lãi là hiệu các số đã làm tròn', () => {
    const rows = buildSummaryRows(
      data({
        finance: [
          financeRow('2026-10-18', 'o1', { revenue: d('1000.25'), invoiceNet: 1 }),
          financeRow('2026-10-18', 'o2', { revenue: d('1000.25'), invoiceNet: 1 }),
          financeRow('2026-10-19', 'o3', { revenue: d('-0.5'), invoiceNet: 0 }),
        ],
        cogs: new Map([
          ['o1', d('0.25')],
          ['o2', d('0.25')],
        ]),
        channels: new Map([
          ['o1', { source: 'manual', shopId: null }],
          ['o2', { source: 'manual', shopId: null }],
          ['o3', { source: 'manual', shopId: null }],
        ]),
      }),
    );
    expect(plain(rows).map((r) => [r.revenue, r.cogs, r.profit])).toEqual([
      ['2001', '1', '2000'],
      ['-1', '0', '-1'],
    ]);
  });

  it('bỏ đơn không có nguồn (không thấy trong sales) và dòng toàn 0', () => {
    const rows = buildSummaryRows(
      data({
        finance: [financeRow('2026-10-18', 'lost', { revenue: d(1), invoiceNet: 1 }), financeRow('2026-10-18', 'o1')],
        paymentFees: [{ day: '2026-10-18', orderId: 'lost', fee: d(5) }],
        channels: new Map([['o1', { source: 'manual', shopId: null }]]),
      }),
    );
    expect(rows).toEqual([]);
  });
});
