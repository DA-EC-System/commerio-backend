import { describe, expect, it } from 'vitest';
import {
  LEDGER_KINDS,
  matchSettlement,
  NOT_SALES_PROFIT,
  OFF_PLATFORM,
  configDraftsOfDelivered,
  feeFixedOf,
  outputVatOf,
  postDelivered,
  postInspected,
  postRefund,
  refundCap,
  refundExcessNote,
  postReturned,
  profitOf,
  taxWarnings,
  netRevenuePortions,
} from '#src/modules/finance/finance/domain/ledger.ts';

const pkg = {
  lines: [
    { variantId: 'trang-m', quantity: 1, unitPrice: '129000.00', unitCost: '60000.00' },
    { variantId: 'den-l', quantity: 1, unitPrice: '129000.00', unitCost: '60000.00' },
  ],
  platformSubsidy: '10000.00',
  shippingIncome: '30000.00',
  shippingCost: '30000.00',
};
const fee = { id: 'fee-v1', payload: { fixedPct: 4, transactionPct: 2, servicePct: 1, optionalPct: 0, returnFee: 15000 } };
const household = { id: 'regime-v1', payload: { regime: 'household' as const } };
const rules = { id: 'rules-v1', payload: { vatPct: 1, pitPct: 0.5, outputVatPct: 10, milestones: [500_000_000, 3_000_000_000] } };
const amounts = (drafts: { kind: string; amount: string }[]) => Object.fromEntries(drafts.map((d) => [d.kind, d.amount]));

describe('ghi sổ khi kiện giao xong (25 §10.1)', () => {
  it('ghi gộp: doanh thu theo giá bán, mỗi loại phí một dòng, thuế khấu trừ của hộ kinh doanh, giá vốn', () => {
    const drafts = postDelivered(pkg, { fee, regime: household, rules });
    expect(amounts(drafts)).toEqual({
      revenue: '258000.00',
      platform_subsidy: '10000.00',
      shipping_income: '30000.00',
      shipping_cost: '-30000.00',
      fee_fixed: '-10320.00',
      fee_transaction: '-5160.00',
      fee_service: '-2580.00',
      withholding_tax: '-3870.00',
      cogs: '-120000.00',
    });
  });

  it('mỗi dòng phí, thuế lưu mã phiên bản cấu hình đã dùng; dòng khác không có', () => {
    const byKind = Object.fromEntries(postDelivered(pkg, { fee, regime: household, rules }).map((d) => [d.kind, d.configVersionId]));
    expect(byKind).toMatchObject({ fee_fixed: 'fee-v1', fee_service: 'fee-v1', withholding_tax: 'rules-v1', revenue: null, cogs: null });
  });

  it('khoản theo cấu hình tính lại trên doanh thu của kiện (dùng cho điều chỉnh hồi tố): khớp các dòng của postDelivered', () => {
    const fromPkg = postDelivered(pkg, { fee, regime: household, rules }).filter((d) => d.configVersionId);
    expect(configDraftsOfDelivered('258000.00', { fee, regime: household, rules }, 2)).toEqual(fromPkg);
  });

  it('hoa hồng theo category (Documents/21 §21.4): mỗi dòng hàng theo tỷ lệ của category của SKU, dòng không khớp theo fixedPct', () => {
    const rated = { id: 'fee-v2', payload: { ...fee.payload, categoryRates: [{ externalCategoryId: '10', path: 'Thời trang', fixedPct: 10 }] } };
    const paths = new Map([['trang-m', ['10', '1001']]]);
    // 129.000 × 10% + 129.000 × 4% = 18.060.
    expect(amounts(postDelivered(pkg, { fee: rated }, paths)).fee_fixed).toBe('-18060.00');
    // Không có chuỗi category: như cấu hình không có categoryRates.
    expect(amounts(postDelivered(pkg, { fee: rated })).fee_fixed).toBe('-10320.00');
    // Không có categoryRates thì bỏ qua chuỗi category.
    expect(amounts(postDelivered(pkg, { fee }, paths)).fee_fixed).toBe('-10320.00');
    // Phần doanh thu không thuộc dòng hàng nào (kiện giao trước #231) theo fixedPct.
    expect(feeFixedOf('258000', rated.payload, [{ revenue: '129000', pathIds: ['10'] }]).toFixed()).toBe('18060');
  });

  it('khoản 0 đồng không ghi: phí tuỳ chọn 0%, không trợ giá, không ship', () => {
    const drafts = postDelivered({ ...pkg, platformSubsidy: '0', shippingIncome: '0', shippingCost: '0' }, { fee });
    expect(drafts.map((d) => d.kind)).toEqual(['revenue', 'fee_fixed', 'fee_transaction', 'fee_service', 'cogs']);
  });

  it('doanh nghiệp không bị sàn khấu trừ thuế; chưa có cấu hình phí, quy tắc thuế thì không ước tính khoản đó', () => {
    const company = { id: 'regime-v2', payload: { regime: 'company' as const } };
    expect(postDelivered(pkg, { fee, regime: company, rules }).some((d) => d.kind === 'withholding_tax')).toBe(false);
    expect(postDelivered(pkg, { regime: household }).map((d) => d.kind)).toEqual(['revenue', 'platform_subsidy', 'shipping_income', 'shipping_cost', 'cogs']);
  });

  it('làm tròn tới đồng, nửa đồng làm tròn lên', () => {
    const one = { ...pkg, lines: [{ variantId: 'x', quantity: 1, unitPrice: '99999.00', unitCost: '0' }] };
    const odd = { id: 'f', payload: { ...fee.payload, fixedPct: 4.44, transactionPct: 0, servicePct: 0 } };
    expect(amounts(postDelivered(one, { fee: odd })).fee_fixed).toBe('-4440.00');
  });

  it('phí cố định mỗi món (#381): một dòng fee_per_item = phí × tổng số món của kiện, mang mã phiên bản phí', () => {
    const perItem = { id: 'fee-v2', payload: { ...fee.payload, perItemFee: 3000 } };
    const two = { ...pkg, lines: [{ ...pkg.lines[0]!, quantity: 2 }] };
    const drafts = postDelivered(two, { fee: perItem });
    expect(drafts.find((d) => d.kind === 'fee_per_item')).toEqual({ kind: 'fee_per_item', amount: '-6000.00', configVersionId: 'fee-v2' });
    expect(configDraftsOfDelivered('258000.00', { fee: perItem }, 2)).toEqual(drafts.filter((d) => d.configVersionId));
  });

  it('bản phí không có phí mỗi món (hay bằng 0): không có dòng fee_per_item, sổ như trước', () => {
    expect(postDelivered(pkg, { fee }).some((d) => d.kind === 'fee_per_item')).toBe(false);
    const zero = { id: 'f0', payload: { ...fee.payload, perItemFee: 0 } };
    expect(postDelivered(pkg, { fee: zero }).some((d) => d.kind === 'fee_per_item')).toBe(false);
    // Kiện không có dòng hàng (giao trước #231, hồi tố đọc 0 món) thì không ước tính phí mỗi món.
    expect(configDraftsOfDelivered('258000.00', { fee: { id: 'f', payload: { ...fee.payload, perItemFee: 3000 } } }, 0)).not.toContainEqual(
      expect.objectContaining({ kind: 'fee_per_item' }),
    );
  });
});

describe('hoàn, trả hàng (25 §10.1)', () => {
  it('kiện hoàn về: phí khi hoàn theo cấu hình; chưa có cấu hình thì không ghi', () => {
    expect(postReturned(fee)).toEqual([{ kind: 'return_fee', amount: '-15000.00', configVersionId: 'fee-v1' }]);
    expect(postReturned(undefined)).toEqual([]);
  });

  it('hoàn tiền khách là khoản ra; nhận số dương hay âm đều ghi âm', () => {
    expect(postRefund('129000')).toEqual([{ kind: 'customer_refund', amount: '-129000.00', configVersionId: null }]);
    expect(postRefund('-129000')[0]!.amount).toBe('-129000.00');
  });

  it('kiểm hàng về: chỉ phần bán lại được ghi giảm giá vốn', () => {
    expect(postInspected([{ resellable: 1, unitCost: '60000' }, { resellable: 0, unitCost: '60000' }])).toEqual([
      { kind: 'cogs_reversal', amount: '60000.00', configVersionId: null },
    ]);
    expect(postInspected([{ resellable: 0, unitCost: '60000' }])).toEqual([]);
  });
});

describe('lãi theo đơn (25 §10.2)', () => {
  const entries = (drafts: { kind: string; amount: string }[], over: { isEstimate?: boolean; replaced?: boolean } = {}) =>
    drafts.map((d) => ({ kind: d.kind as never, amount: d.amount, isEstimate: over.isEstimate ?? true, replaced: over.replaced ?? false }));

  it('thực nhận không gồm giá vốn; lãi gộp = thực nhận + giá vốn; còn dòng ước tính thì estimated', () => {
    const p = profitOf(entries(postDelivered(pkg, { fee, regime: household, rules })));
    expect(p).toEqual({ net: 246070, cogs: -120000, gross: 126070, estimated: true });
  });

  it('trả một áo: hoàn tiền khách, áo bán lại được thì giá vốn giảm', () => {
    const all = [
      ...postDelivered(pkg, { fee, regime: household, rules }),
      ...postRefund('129000'),
      ...postInspected([{ resellable: 1, unitCost: '60000' }]),
    ];
    expect(profitOf(entries(all))).toMatchObject({ net: 117070, cogs: -60000, gross: 57070 });
  });

  it('US-TI-14 dòng 2: doanh nghiệp không có dòng thuế khấu trừ; thực nhận bỏ GTGT đầu ra khỏi doanh thu thuần (chia 1 + v)', () => {
    const company = { id: 'regime-v2', payload: { regime: 'company' as const } };
    const drafts = postDelivered(pkg, { fee, regime: company, rules });
    expect(drafts.some((d) => d.kind === 'withholding_tax')).toBe(false);
    expect(amounts(drafts).revenue).toBe('258000.00'); // sổ ghi đủ tiền sàn trả, để so với quyết toán
    const lines = drafts.map((d) => ({ kind: d.kind, amount: d.amount, isEstimate: true, replaced: false }));
    const vat = outputVatOf({ kind: 'revenue', amount: amounts(drafts).revenue!, outputVatPct: 10 });
    // 258000 / 1,1 = 234545,45 → 234545; phần GTGT 23455. Thực nhận hộ kinh doanh 246070 + thuế khấu trừ 3870 − 23455.
    expect(profitOf(lines, vat)).toEqual({ net: 226485, cogs: -120000, gross: 106485, estimated: true });
  });

  it('phần GTGT đầu ra chỉ tính trên doanh thu, hoàn tiền khách; thuế suất 0 thì không bỏ gì', () => {
    expect(outputVatOf({ kind: 'revenue', amount: '110000.00', outputVatPct: 10 }).toNumber()).toBe(10000);
    expect(outputVatOf({ kind: 'customer_refund', amount: '-110000.00', outputVatPct: 10 }).toNumber()).toBe(-10000);
    expect(outputVatOf({ kind: 'fee_fixed', amount: '-4400.00', outputVatPct: 10 }).toNumber()).toBe(0);
    expect(outputVatOf({ kind: 'revenue', amount: '110000.00', outputVatPct: 0 }).toNumber()).toBe(0);
  });

  it('dòng đã có số thật thay thì bỏ; chỉ còn dòng thực tế thì hết estimated', () => {
    const estimate = entries([{ kind: 'fee_fixed', amount: '-10320.00' }], { replaced: true });
    const actual = entries([{ kind: 'fee_fixed', amount: '-11000.00' }], { isEstimate: false });
    expect(profitOf([...estimate, ...actual])).toEqual({ net: -11000, cogs: 0, gross: -11000, estimated: false });
  });
});

describe('cảnh báo mốc thuế (25 §10.4)', () => {
  const ms = [500_000_000, 3_000_000_000];
  it('dưới 90% mốc thì không cảnh báo', () => expect(taxWarnings(440_000_000, ms)).toEqual([]));
  it('từ 90% mốc thì cảnh báo, vượt thì over', () => {
    expect(taxWarnings(460_000_000, ms)).toEqual([{ milestone: 500_000_000, ytdRevenue: 460_000_000, over: false }]);
    expect(taxWarnings(2_800_000_000, ms)).toEqual([
      { milestone: 500_000_000, ytdRevenue: 2_800_000_000, over: true },
      { milestone: 3_000_000_000, ytdRevenue: 2_800_000_000, over: false },
    ]);
  });
});

describe('khoản ngoài sàn, không vào lãi bán hàng (25 §10.1, §10.2; 21 §21.1)', () => {
  it('khoản ngoài sàn đúng bốn loại của 25 §10.1: trả NCC, NCC hoàn tiền, COD tự giao, chi vận hành', () => {
    expect([...OFF_PLATFORM].sort()).toEqual(['cod_collected', 'opex', 'supplier_payment', 'supplier_refund']);
  });

  it('không vào lãi gộp: khoản ngoài sàn, rút tiền, quảng cáo (lãi đóng góp = lãi gộp − quảng cáo); giá vốn vẫn vào', () => {
    expect([...NOT_SALES_PROFIT].sort()).toEqual(['ads', 'cod_collected', 'opex', 'supplier_payment', 'supplier_refund', 'withdrawal']);
    expect(NOT_SALES_PROFIT.has('cogs')).toBe(false);
  });

  it('mọi loại khác trong enum là khoản của sàn', () => {
    const platform = LEDGER_KINDS.filter((k) => !OFF_PLATFORM.has(k));
    expect(platform).toEqual(expect.arrayContaining(['revenue', 'ads', 'penalty', 'withdrawal', 'adjustment', 'cogs']));
    expect(platform.length + OFF_PLATFORM.size).toBe(LEDGER_KINDS.length);
  });
});

describe('matchSettlement (#231)', () => {
  const est = (id: string, kind: 'revenue' | 'fee_fixed' | 'customer_refund', sourceId: string, sourceType = 'package') => ({
    id,
    orderId: 'o',
    kind,
    sourceType,
    sourceId,
  });

  it('loại khác doanh thu chỉ nối với kiện mà doanh thu của lô đã nối; kiện kia không có loại đó thì để không nối', () => {
    const open = [est('r1', 'revenue', 'k1'), est('r2', 'revenue', 'k2'), est('f2', 'fee_fixed', 'k2')];
    const out = matchSettlement(
      [
        { txnId: 'fee', orderId: 'o', kind: 'fee_fixed' },
        { txnId: 'rev', orderId: 'o', kind: 'revenue' },
      ],
      open,
    );
    expect([...out]).toEqual([['rev', 'r1']]);
  });

  it('nguồn không phải kiện (hoàn tiền) nối theo đơn, loại; dòng không đơn không nối', () => {
    const open = [est('c1', 'customer_refund', 'rr1', 'return_refund')];
    const out = matchSettlement(
      [
        { txnId: 'x', orderId: null, kind: 'customer_refund' },
        { txnId: 'ref', orderId: 'o', kind: 'customer_refund' },
      ],
      open,
    );
    expect([...out]).toEqual([['ref', 'c1']]);
  });
});

describe('chia doanh thu thuần theo ngày giao để chọn GTGT đầu ra (US-TI-13 dòng 3)', () => {
  const line = (id: string, kind: 'revenue' | 'customer_refund' | 'fee_fixed', amount: string, occurredOn: string, isEstimate: boolean, replacesId: string | null = null) => ({
    id,
    orderId: 'o1',
    kind,
    amount,
    occurredOn,
    isEstimate,
    replacesId,
  });
  const vatAt = (byDay: Record<string, number>) => (portions: { kind: 'revenue' | 'customer_refund' | 'fee_fixed' | string; amount: string; day: string }[]) =>
    portions.reduce((s, p) => s + outputVatOf({ kind: p.kind as never, amount: p.amount, outputVatPct: byDay[p.day] ?? 0 }).toNumber(), 0);

  it('dòng thực tế thay dòng ước tính lấy ngày dòng đó; dòng khác ngoài doanh thu thuần bỏ qua', () => {
    const est = line('e1', 'revenue', '110000', '2026-10-28', true);
    const act = line('a1', 'revenue', '110000', '2026-11-03', false, 'e1');
    expect(netRevenuePortions([act, line('f', 'fee_fixed', '-1', '2026-11-03', false)], [est])).toEqual([{ kind: 'revenue', amount: '110000', day: '2026-10-28' }]);
  });

  it('đơn hai kiện giao 31/10 (10%), 01/11 (8%), sàn quyết toán một dòng 1.000.000 đ: chia theo doanh thu ước tính từng ngày', () => {
    const estimates = [line('e1', 'revenue', '600000', '2026-10-31', true), line('e2', 'revenue', '400000', '2026-11-01', true)];
    const portions = netRevenuePortions([line('a', 'revenue', '1000000', '2026-11-10', false)], estimates);
    expect(portions).toEqual([
      { kind: 'revenue', amount: '600000.00', day: '2026-10-31' },
      { kind: 'revenue', amount: '400000.00', day: '2026-11-01' },
    ]);
    // 600.000 − 545.455 = 54.545; 400.000 − 370.370 = 29.630.
    expect(vatAt({ '2026-10-31': 10, '2026-11-01': 8 })(portions)).toBe(84175);
  });

  it('hoàn toàn bộ ngày 02/11 (đã 8%) cho kiện giao 31/10 (10%): GTGT theo ngày giao, doanh thu thuần 0 thì GTGT 0', () => {
    const est = line('e1', 'revenue', '1100000', '2026-10-31', true);
    const refund = line('r1', 'customer_refund', '-1100000', '2026-11-02', true);
    const portions = netRevenuePortions([est, refund], [est]);
    expect(portions.map((p) => p.day)).toEqual(['2026-10-31', '2026-10-31']);
    expect(vatAt({ '2026-10-31': 10, '2026-11-02': 8 })(portions)).toBe(0);
  });

  it('chia lẻ: phần cuối nhận số dư, tổng các phần bằng dòng gốc; đơn không có dòng ước tính thì ngày của chính dòng', () => {
    const estimates = [line('e1', 'revenue', '1', '2026-10-30', true), line('e2', 'revenue', '1', '2026-10-31', true), line('e3', 'revenue', '1', '2026-11-01', true)];
    const portions = netRevenuePortions([line('a', 'revenue', '100', '2026-11-10', false)], estimates);
    expect(portions.map((p) => p.amount)).toEqual(['33.00', '33.00', '34.00']);
    expect(netRevenuePortions([line('b', 'revenue', '100', '2026-11-10', false)], [])).toEqual([{ kind: 'revenue', amount: '100', day: '2026-11-10' }]);
  });
});

describe('refundCap: trần ghi hoàn tiền (#355)', () => {
  const rev = (entries: [string, string][]) => new Map(entries);
  const line = (packageId: string | null, quantity: number, unitPrice = '100000') => ({ packageId, quantity, unitPrice });
  const cap = (b: Parameters<typeof refundCap>[0]) => {
    const r = refundCap(b);
    return [r.cap.toFixed(0), r.post.toFixed(0), r.excess.toFixed(0)];
  };

  it('kiện của dòng trả chưa có doanh thu (COD hoàn về): ghi 0, vượt cả số', () => {
    expect(cap({ refundAmount: '110000', lines: [line('p1', 1)], revenueByPackage: rev([]), refunded: '0' })).toEqual(['0', '0', '110000']);
  });

  it('trong trần: ghi đủ', () => {
    expect(cap({ refundAmount: '100000', lines: [line('p1', 1)], revenueByPackage: rev([['p1', '200000']]), refunded: '0' })).toEqual([
      '100000',
      '100000',
      '0',
    ]);
  });

  it('trần là phần nhỏ hơn giữa doanh thu dòng trả và doanh thu đơn còn lại sau các lần hoàn trước', () => {
    expect(cap({ refundAmount: '100000', lines: [line('p1', 1)], revenueByPackage: rev([['p1', '200000']]), refunded: '150000' })).toEqual([
      '50000',
      '50000',
      '50000',
    ]);
  });

  it('dòng không gắn kiện, hoặc kiện có tổng doanh thu không dương, không tính; trần không âm', () => {
    expect(
      cap({ refundAmount: '50000', lines: [line(null, 1), line('p2', 1)], revenueByPackage: rev([['p2', '0'], ['p3', '100000']]), refunded: '300000' }),
    ).toEqual(['0', '0', '50000']);
  });

  it('số sàn báo âm được lấy trị tuyệt đối', () => {
    expect(cap({ refundAmount: '-100000', lines: [line('p1', 1)], revenueByPackage: rev([['p1', '100000']]), refunded: '0' })[1]).toBe('100000');
  });

  it('câu cờ ghi số theo dấu chấm nghìn', () => {
    const r = refundCap({ refundAmount: '1234567', lines: [line('p1', 1)], revenueByPackage: rev([['p1', '100000']]), refunded: '0' });
    expect(refundExcessNote('1234567', r.cap, r.excess)).toBe(
      'Sàn báo hoàn 1.234.567 ₫ vượt doanh thu đã ghi của phần trả (100.000 ₫); phần vượt 1.134.567 ₫ không ghi sổ (kiện chưa giao hoặc COD hoàn về), đối chiếu với sàn',
    );
  });
});
