import { describe, expect, it } from 'vitest';
import { postDelivered, postInspected, postRefund, postReturned, profitOf, taxWarnings } from '#src/modules/finance/finance/domain/ledger.ts';

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
const rules = { id: 'rules-v1', payload: { vatPct: 1, pitPct: 0.5, milestones: [500_000_000, 3_000_000_000] } };
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
