import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { lazadaLedgerKind } from '#src/modules/channel/channel/service/marketplaces/lazada.ts';
import type { PlatformPayout, PlatformTxn } from '#src/modules/finance/finance/domain/settlement.ts';
import { recordPackageDelivered } from '#src/modules/finance/finance/service/ledger.ts';
import { markOrderCancelled } from '#src/modules/finance/finance/service/order-settlement-state.ts';
import { openRun, processRun, runSettlement, runSettlementJob } from '#src/modules/finance/finance/service/settlement-runs.ts';
import type { FinanceContext } from '#src/modules/finance/finance/service/settlement-views.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { setModuleEnabled } from '../../helpers/state.ts';
import { createOrder } from '../../helpers/sales.ts';

// Đối soát quyết toán (#117, Documents/21 §21.2, §21.3). Sàn thay bằng cổng giả trong `ctx`: dữ liệu như sàn giả lập
// #115 (2 áo × 129.000 đ). Giờ cố định 10:00 ngày 05/11/2026 giờ Việt Nam: chỉ giả `Date`.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-05T03:00:00Z'));
});
afterAll(() => {
  vi.useRealTimers();
});

const app = testApp();
const API = '/api/v1/finance';
const get = (token: string, path: string) => request(app).get(`${API}${path}`).set('Authorization', `Bearer ${token}`);
const post = (token: string, path: string, body: object) => request(app).post(`${API}${path}`).set('Authorization', `Bearer ${token}`).send(body);

function fakeSource(txns: () => PlatformTxn[], payouts: () => PlatformPayout[] = () => []): FinanceContext {
  return {
    authorize: () => (_req, _res, next) => next(),
    settlementSource: { transactions: async () => txns(), payouts: async () => payouts(), shops: async () => [] },
  };
}

const EXT = '600000000000001';
const txn = (id: string, feeName: string, transactionType: string, amount: string, externalOrderId: string | null = EXT): PlatformTxn => ({
  txnId: id,
  externalOrderId,
  date: '2026-11-04',
  feeName,
  feeCode: null,
  transactionType,
  amount,
  withholding: '0',
  kind: lazadaLedgerKind(feeName, transactionType),
});
/** Quyết toán của đơn 2 áo; `commission` là phí cố định mỗi áo. */
const settlementOf = (prefix: string, commission: string) => [
  txn(`${prefix}1`, 'Item Price Credit', 'Orders-Sales', '129000.00'),
  txn(`${prefix}2`, 'Item Price Credit', 'Orders-Sales', '129000.00'),
  txn(`${prefix}3`, 'Commission', 'Orders-Lazada Fees', commission),
  txn(`${prefix}4`, 'Commission', 'Orders-Lazada Fees', commission),
  txn(`${prefix}5`, 'Payment Fee', 'Orders-Lazada Fees', '-2580.00'),
  txn(`${prefix}6`, 'Payment Fee', 'Orders-Lazada Fees', '-2580.00'),
];

async function config(companyId: string, kind: string, shopId: string | null, payload: object, createdBy: string = randomUUID()) {
  await testPool().query(
    `insert into finance.config_versions (company_id, kind, shop_id, status, payload, effective_from, created_by, approved_by, approved_at)
     values ($1, $2, $3, 'active', $4, '2026-10-01', $5, $6, now())`,
    [companyId, kind, shopId, JSON.stringify(payload), createdBy, randomUUID()],
  );
}

async function setup() {
  const c = await createCompany();
  const shopId = randomUUID();
  const admin = await addMember(c.companyId, 'admin');
  const author = await addMember(c.companyId, 'admin');
  await config(c.companyId, 'fee', shopId, { fixedPct: 4, transactionPct: 2, servicePct: 0, optionalPct: 0, returnFee: 15000 }, author.accountId);
  await config(c.companyId, 'mismatch_threshold', null, { abs: 5000, pct: 1, resolveLimit: 10000 });
  const v = await createVariant(c.companyId);
  const order = await createOrder(c.companyId, { lines: [{ variantId: v.variantId, quantity: 2, unitPrice: 129000 }], source: 'marketplace' });
  await testPool().query(`update "order".orders set shop_id = $1, external_order_id = $2 where id = $3`, [shopId, EXT, order.orderId]);
  return { companyId: c.companyId, ceo: c.ceo.token, admin, author, shopId, order, variantId: v.variantId };
}

async function deliver(s: Awaited<ReturnType<typeof setup>>) {
  await recordPackageDelivered(s.companyId, {
    packageId: randomUUID(),
    orderId: s.order.orderId,
    shopId: s.shopId,
    deliveredAt: '2026-11-01T08:00:00Z',
    lines: [{ variantId: s.variantId, quantity: 2, unitPrice: '129000', unitCost: '60000' }],
    platformSubsidy: '0',
    shippingIncome: '0',
    shippingCost: '0',
  });
}

const settlement = async (companyId: string, orderId: string) =>
  (await testPool().query('select status, estimated_total, settled_total, diff from finance.order_settlements where order_id = $1', [orderId])).rows[0];

describe('kéo quyết toán (§21.3)', () => {
  it('khớp: mỗi khoản một dòng thực tế, nối về dòng ước tính cùng loại, đơn settled; chạy lại không ghi trùng', async () => {
    const s = await setup();
    await deliver(s);
    expect(await settlement(s.companyId, s.order.orderId)).toMatchObject({ status: 'pending', estimated_total: '242520.00' });

    const ctx = fakeSource(() => settlementOf('A', '-5160.00'));
    const run = await runSettlement(ctx, s.companyId, null, s.shopId);
    expect(run).toMatchObject({ status: 'done', lineCount: 6, duplicates: 0 });
    expect(await settlement(s.companyId, s.order.orderId)).toMatchObject({ status: 'settled', settled_total: '242520.00', diff: '0.00' });

    const linked = await testPool().query(
      `select a.kind from finance.ledger_entries a join finance.ledger_entries e on e.id = a.replaces_entry_id where a.order_id = $1 order by a.kind`,
      [s.order.orderId],
    );
    expect(linked.rows.map((r) => r.kind).sort()).toEqual(['fee_fixed', 'fee_transaction', 'revenue']);
    const profit = await get(s.ceo, `/orders/${s.order.orderId}/profit`);
    expect(profit.body).toMatchObject({ net: 242520, estimated: false });

    const again = await runSettlement(ctx, s.companyId, null, s.shopId);
    expect(again).toMatchObject({ status: 'done', lineCount: 0, duplicates: 6 });
    expect((await get(s.ceo, '/settlement-runs')).body.total).toBe(2);
  });

  it('sàn thu phí của đơn đã huỷ, chưa giao kiện nào: mismatch (cancelled_charged)', async () => {
    const s = await setup();
    await testPool().query(`update "order".orders set status = 'cancelled' where id = $1`, [s.order.orderId]);
    await runSettlement(fakeSource(() => [txn('C1', 'Commission', 'Orders-Lazada Fees', '-3000.00')]), s.companyId, null, s.shopId);
    expect(await settlement(s.companyId, s.order.orderId)).toMatchObject({ status: 'mismatch', diff: '-3000.00' });
  });

  it('D43-03 (E140): khoản của đơn sàn không có trong app thành dòng của gian hàng, cờ Không rõ đơn; nạp lại không trùng', async () => {
    const s = await setup();
    const ghost = [txn('G1', 'Item Price Credit', 'Orders-Sales', '99000.00', '700000000000009')];
    const first = await runSettlement(fakeSource(() => ghost), s.companyId, null, s.shopId);
    expect(first).toMatchObject({ status: 'done', lineCount: 1, duplicates: 0 });
    const res = await get(s.ceo, `/ledger?shopId=${s.shopId}&pageSize=100`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const line = res.body.items.find((l: { txnId: string }) => l.txnId === 'G1');
    expect(line).toMatchObject({ orderId: null, externalOrderId: '700000000000009', flags: ['unknown_order'], shopId: s.shopId });
    const { rows } = await testPool().query('select count(*)::int as n from "order".orders where company_id = $1', [s.companyId]);
    expect(rows[0].n).toBe(1);
    const again = await runSettlement(fakeSource(() => ghost), s.companyId, null, s.shopId);
    expect(again).toMatchObject({ status: 'done', lineCount: 0, duplicates: 1 });
  });

  it('khoá chống trùng là (gian hàng, mã giao dịch): cùng mã ở gian hàng khác vẫn ghi (#250)', async () => {
    const s = await setup();
    const other = randomUUID();
    const same = () => [txn('SAME-1', 'Payment Fee', 'Orders-Lazada Fees', '-1000.00', null)];
    expect(await runSettlement(fakeSource(same), s.companyId, null, s.shopId)).toMatchObject({ lineCount: 1 });
    expect(await runSettlement(fakeSource(same), s.companyId, null, other)).toMatchObject({ lineCount: 1, duplicates: 0 });
    expect(await runSettlement(fakeSource(same), s.companyId, null, other)).toMatchObject({ lineCount: 0, duplicates: 1 });
  });

  it('khoản adapter không nhận ra ghi adjustment kèm tên phí gốc (#203)', async () => {
    const s = await setup();
    await runSettlement(fakeSource(() => [txn('U1', 'Phí lạ', 'Other', '-700.00', null)]), s.companyId, null, s.shopId);
    const res = await get(s.ceo, `/ledger?shopId=${s.shopId}&pageSize=100`);
    expect(res.body.items.find((l: { txnId: string }) => l.txnId === 'U1')).toMatchObject({ kind: 'adjustment', reason: 'Phí lạ' });
  });

  it('E135: thuế sàn trừ khác thuế app ước tính thì trạng thái tiền có cờ Lệch thuế, số sàn trừ là số thật', async () => {
    const s = await setup();
    await config(s.companyId, 'tax_regime', null, { regime: 'household' });
    await config(s.companyId, 'tax_rules', null, { vatPct: 1, pitPct: 0.5, milestones: [500_000_000, 3_000_000_000] });
    await deliver(s);
    // App ước tính 1,5% của 258.000 = 3.870; sàn trừ 2.580 (1%)
    const lines = settlementOf('T', '-5160.00').map((t, i) => (i === 0 ? { ...t, withholding: '2580.00' } : t));
    await runSettlement(fakeSource(() => lines), s.companyId, null, s.shopId);
    const p = await get(s.ceo, `/payments/${s.order.orderId}`);
    expect(p.body.flags).toEqual(['tax_mismatch']);
    const wht = p.body.lines.filter((l: { kind: string; estimated: boolean }) => l.kind === 'withholding_tax' && !l.estimated);
    expect(wht.map((l: { amount: number }) => l.amount)).toEqual([-2580]);
    expect((await get(s.ceo, '/payments')).body.items.find((i: { orderId: string }) => i.orderId === s.order.orderId).flags).toEqual([
      'tax_mismatch',
    ]);
  });

  it('D43-07 (E139): quyết toán về trước khi kiện giao xong: ghi số thật, giữ chờ; kiện giao xong thì xét khớp', async () => {
    const s = await setup();
    await runSettlement(fakeSource(() => settlementOf('E', '-5160.00')), s.companyId, null, s.shopId);
    expect(await settlement(s.companyId, s.order.orderId)).toMatchObject({ status: 'none', settled_total: '242520.00' });
    const early = await get(s.ceo, `/payments/${s.order.orderId}`);
    expect(early.body.lines.filter((l: { estimated: boolean }) => !l.estimated)).toHaveLength(6);
    expect(early.body.statusHistory).toEqual([]);
    await deliver(s);
    expect(await settlement(s.companyId, s.order.orderId)).toMatchObject({ status: 'settled' });
    const p = await get(s.ceo, `/payments/${s.order.orderId}`);
    expect(p.body.statusHistory.map((h: { to: string; source: string }) => [h.to, h.source])).toEqual([
      ['pending', 'system'],
      ['settled', 'marketplace'],
    ]);
  });

  it('D43-07: quyết toán về trước, kiện giao xong thì lệch quá ngưỡng là mismatch', async () => {
    const s = await setup();
    await runSettlement(fakeSource(() => settlementOf('F', '-10320.00')), s.companyId, null, s.shopId);
    expect(await settlement(s.companyId, s.order.orderId)).toMatchObject({ status: 'none' });
    await deliver(s);
    expect(await settlement(s.companyId, s.order.orderId)).toMatchObject({ status: 'mismatch', diff: '-10320.00' });
  });

  it('D43-08 (US-TI-06 dòng 2): khoản chưa ánh xạ ghi adjustment kèm tên và mã phí gốc, tính vào lệch của đơn', async () => {
    const s = await setup();
    await deliver(s);
    const lines = [...settlementOf('A', '-5160.00'), { ...txn('A9', 'Phí dịch vụ mới', 'Orders-Other', '-2000.00'), feeCode: 'FT_NEW_42' }];
    await runSettlement(fakeSource(() => lines), s.companyId, null, s.shopId);
    const p = await get(s.ceo, `/payments/${s.order.orderId}`);
    expect(p.body.lines.find((l: { txnId: string }) => l.txnId === 'A9')).toMatchObject({
      kind: 'adjustment',
      reason: 'Phí dịch vụ mới (mã FT_NEW_42)',
      estimated: false,
    });
    expect(p.body.diff).toBe(-2000);
  });

  it('D43-09 (US-TI-08 dòng 1, 4): điều chỉnh muộn trong ngưỡng giữ settled; bồi thường thất lạc không tính lệch', async () => {
    const s = await setup();
    await deliver(s);
    await runSettlement(fakeSource(() => settlementOf('B', '-5160.00')), s.companyId, null, s.shopId);
    expect(await settlement(s.companyId, s.order.orderId)).toMatchObject({ status: 'settled' });
    await runSettlement(fakeSource(() => [txn('B7', 'Commission', 'Orders-Lazada Fees', '-1000.00')]), s.companyId, null, s.shopId);
    expect(await settlement(s.companyId, s.order.orderId)).toMatchObject({ status: 'settled', diff: '-1000.00' });
    await runSettlement(fakeSource(() => [txn('B8', 'Lost Claim', 'Refunds-Claims', '129000.00')]), s.companyId, null, s.shopId);
    expect(await settlement(s.companyId, s.order.orderId)).toMatchObject({ status: 'settled', diff: '-1000.00' });
    const comp = await testPool().query("select count(*)::int as n from finance.ledger_entries where external_transaction_id = 'B8' and kind = 'lost_compensation'");
    expect(comp.rows[0].n).toBe(1);
  });

  it('D43-10 (US-TI-06 dòng 7, 11): khoản phạt không gắn đơn là dòng của gian hàng; Sale, Kho không kéo được (403)', async () => {
    const s = await setup();
    await runSettlement(fakeSource(() => [txn('P1', 'Penalty', 'Other', '-50000.00', null)]), s.companyId, null, s.shopId);
    const res = await get(s.ceo, `/ledger?shopId=${s.shopId}&pageSize=100`);
    expect(res.body.items.find((l: { txnId: string }) => l.txnId === 'P1')).toMatchObject({ kind: 'penalty', orderId: null, flags: [] });
    for (const role of ['sale', 'warehouse'] as const) {
      const m = await addMember(s.companyId, role);
      const post403 = await post(m.token, '/settlement-runs', { shopId: s.shopId });
      expect([role, post403.status, post403.body.type]).toEqual([role, 403, '/problems/forbidden']);
    }
  });

  it('nhập tệp báo cáo quyết toán chưa làm: 422 file_import_unsupported (#251)', async () => {
    const s = await setup();
    const res = await post(s.ceo, '/settlement-runs', { shopId: s.shopId, fileId: randomUUID() });
    expect([res.status, res.body.type]).toEqual([422, '/problems/file_import_unsupported']);
  });

  it('gọi sàn lỗi: lần chạy failed kèm lý do, lần sau kéo lại từ mốc cũ; đang có lần chạy thì 409', async () => {
    const s = await setup();
    const broken = fakeSource(() => {
      throw new Error('sàn không trả lời');
    });
    const failed = await runSettlement(broken, s.companyId, null, s.shopId);
    expect(failed).toMatchObject({ status: 'failed', error: 'sàn không trả lời' });
    const ctx = fakeSource(() => []);
    const open = await openRun(ctx, s.companyId, null, s.shopId);
    expect(open.periodFrom.toISOString()).toBe(failed.periodFrom.toISOString());
    await expect(openRun(ctx, s.companyId, null, s.shopId)).rejects.toMatchObject({ code: 'settlement_running' });
    expect((await processRun(ctx, s.companyId, open.id)).status).toBe('done');
  });

  it('D43-04 (E142): lượt chưa cuối lỗi thì giữ running, không ghi gì, mốc không tiến; lượt sau ghi đủ, không trùng', async () => {
    const s = await setup();
    await deliver(s);
    const run = await openRun(fakeSource(() => []), s.companyId, null, s.shopId);
    let calls = 0;
    const flaky = fakeSource(() => {
      calls++;
      if (calls === 1) throw new Error('tiến trình chết giữa lô');
      return settlementOf('K', '-5160.00');
    });
    await expect(processRun(flaky, s.companyId, run.id, { lastAttempt: false })).rejects.toThrow('tiến trình chết giữa lô');
    const mid = await testPool().query('select status from finance.settlement_batches where id = $1', [run.id]);
    expect(mid.rows[0].status).toBe('running');
    const before = await testPool().query("select count(*)::int as n from finance.ledger_entries where source_id = $1", [run.id]);
    expect(before.rows[0].n).toBe(0);
    const done = await processRun(flaky, s.companyId, run.id, { lastAttempt: false });
    expect(done).toMatchObject({ status: 'done', lineCount: 6, duplicates: 0 });
    // Việc bị nhận lại thêm lần nữa sau khi xong: không ghi thêm
    expect((await processRun(flaky, s.companyId, run.id)).status).toBe('done');
    const after = await testPool().query("select count(*)::int as n from finance.ledger_entries where source_id = $1", [run.id]);
    expect(after.rows[0].n).toBe(6);
  });

  it('D43-05 (E142): lần running đứng quá 1 giờ thì lần mở sau đánh failed thay vì 409', async () => {
    const s = await setup();
    const ctx = fakeSource(() => []);
    const stuck = await openRun(ctx, s.companyId, null, s.shopId);
    await expect(openRun(ctx, s.companyId, null, s.shopId)).rejects.toMatchObject({ code: 'settlement_running' });
    await testPool().query("update finance.settlement_batches set updated_at = '2026-11-05T01:30:00Z' where id = $1", [stuck.id]);
    const next = await openRun(ctx, s.companyId, null, s.shopId);
    expect(next.periodFrom.toISOString()).toBe(stuck.periodFrom.toISOString());
    const old = await testPool().query('select status, error from finance.settlement_batches where id = $1', [stuck.id]);
    expect(old.rows[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('dừng giữa chừng') });
  });

  it('D43-06: mở lần chạy gửi việc finance.settlement_run; lượt cuối lỗi thì việc lỗi, Admin chạy lại thì lần đó chạy tiếp', async () => {
    const s = await setup();
    const run = await openRun(fakeSource(() => []), s.companyId, null, s.shopId);
    const jobs = await testPool().query("select data from pgboss.job where name = 'finance.settlement_run' and data->>'runId' = $1", [run.id]);
    expect(jobs.rows).toEqual([{ data: { companyId: s.companyId, shopId: s.shopId, runId: run.id } }]);
    const broken = fakeSource(() => {
      throw new Error('sàn bảo trì');
    });
    const job = { companyId: s.companyId, runId: run.id };
    await expect(runSettlementJob(broken, job, { attempt: 3, lastAttempt: true })).rejects.toThrow('sàn bảo trì');
    await runSettlementJob(fakeSource(() => []), job, { attempt: 1, lastAttempt: false });
    const row = await testPool().query('select status, error from finance.settlement_batches where id = $1', [run.id]);
    expect(row.rows[0]).toEqual({ status: 'done', error: null });
  });

  it('rút tiền: dòng withdrawal không gắn đơn, tổng withdrawn; số dư ví lệch; khớp sao kê một lần', async () => {
    const s = await setup();
    await deliver(s);
    const ctx = fakeSource(
      () => [...settlementOf('W', '-5160.00'), txn('W9', 'Seller Payout', 'Payout', '-200000.00', null)],
      () => [{ statementNumber: 'VN2026W44', createdAt: '2026-11-04', payout: '42520.00', closingBalance: '40000.00', paid: true }],
    );
    const run = await runSettlement(ctx, s.companyId, null, s.shopId);
    expect(run.walletDiff).toBe('-2520.00');
    expect((await get(s.ceo, '/ledger')).body.totals).toMatchObject({ platformBalance: 42520, withdrawn: 200000 });

    const open = await get(s.ceo, '/bank-matching?matched=false');
    expect(open.body.items.map((l: { kind: string; txnId: string }) => [l.kind, l.txnId])).toEqual([['withdrawal', 'W9']]);
    const id = open.body.items[0].id;
    const matched = await post(s.ceo, `/ledger/${id}/bank-match`, { bankRef: 'VCB-0001' });
    expect(matched.status).toBe(200);
    expect(matched.body.bankMatch).toMatchObject({ bankRef: 'VCB-0001' });
    const twice = await post(s.ceo, `/ledger/${id}/bank-match`, { bankRef: 'VCB-0002' });
    expect([twice.status, twice.body.type]).toEqual([409, '/problems/already_matched']);
    expect((await get(s.ceo, '/bank-matching?matched=true')).body.total).toBe(1);
  });

  it('D43-05: việc của lần đã bị đánh failed chạy muộn thì không ghi dòng nào dưới lần đó (review #273)', async () => {
    const s = await setup();
    await deliver(s);
    const run = await openRun(fakeSource(() => []), s.companyId, null, s.shopId);
    // Lần mở sau đánh lần này failed đúng lúc việc cũ đang gọi sàn (giữa bước gọi sàn và bước ghi)
    const late = fakeSource(() => settlementOf('L', '-5160.00'));
    late.settlementSource!.payouts = async () => {
      await testPool().query("update finance.settlement_batches set status = 'failed', error = 'quá thời gian chờ' where id = $1", [run.id]);
      return [];
    };
    const result = await processRun(late, s.companyId, run.id);
    expect(result.status).toBe('failed');
    const rows = await testPool().query('select count(*)::int as n from finance.ledger_entries where source_id = $1', [run.id]);
    expect(rows.rows[0].n).toBe(0);
    expect(await settlement(s.companyId, s.order.orderId)).toMatchObject({ status: 'pending' });
  });

  it('mã giao dịch lặp ngay trong một lô: ghi một dòng, đếm phần lặp vào duplicates, lần chạy vẫn done (review #274)', async () => {
    const s = await setup();
    const twice = () => [
      txn('D-1', 'Payment Fee', 'Orders-Lazada Fees', '-1000.00', null),
      txn('D-1', 'Payment Fee', 'Orders-Lazada Fees', '-1000.00', null),
    ];
    const run = await runSettlement(fakeSource(twice), s.companyId, null, s.shopId);
    expect(run).toMatchObject({ status: 'done', lineCount: 1, duplicates: 1 });
    expect(await runSettlement(fakeSource(twice), s.companyId, null, s.shopId)).toMatchObject({ status: 'done', lineCount: 0, duplicates: 2 });
  });

  it('E135: sàn không trừ thuế trong khi app ước tính có thuế thì vẫn có cờ Lệch thuế; chưa quyết toán thì chưa có cờ (review #274)', async () => {
    const s = await setup();
    await config(s.companyId, 'tax_regime', null, { regime: 'household' });
    await config(s.companyId, 'tax_rules', null, { vatPct: 1, pitPct: 0.5, milestones: [500_000_000, 3_000_000_000] });
    await deliver(s);
    expect((await get(s.ceo, `/payments/${s.order.orderId}`)).body.flags).toEqual([]);
    await runSettlement(fakeSource(() => settlementOf('Z', '-5160.00')), s.companyId, null, s.shopId);
    const p = await get(s.ceo, `/payments/${s.order.orderId}`);
    expect(p.body.lines.filter((l: { kind: string; estimated: boolean }) => l.kind === 'withholding_tax' && !l.estimated)).toEqual([]);
    expect(p.body.flags).toEqual(['tax_mismatch']);
  });

  it('D43-12 (E139 rồi huỷ): đơn giữ none vì quyết toán về trước, sau đó bị huỷ thì sang mismatch (cancelled_charged)', async () => {
    const s = await setup();
    await runSettlement(fakeSource(() => settlementOf('H', '-5160.00')), s.companyId, null, s.shopId);
    expect(await settlement(s.companyId, s.order.orderId)).toMatchObject({ status: 'none', settled_total: '242520.00' });
    await testPool().query(`update "order".orders set status = 'cancelled' where id = $1`, [s.order.orderId]);
    await withCompany(s.companyId, () => markOrderCancelled(s.order.orderId));
    expect(await settlement(s.companyId, s.order.orderId)).toMatchObject({ status: 'mismatch', diff: '242520.00' });
    const p = await get(s.ceo, `/payments/${s.order.orderId}`);
    expect(p.body.statusHistory.map((h: { to: string; action?: string }) => h.to)).toEqual(['mismatch']);
    // Sự kiện huỷ giao lại, hoặc đơn chưa có số quyết toán: không đổi gì
    await withCompany(s.companyId, () => markOrderCancelled(s.order.orderId));
    await withCompany(s.companyId, () => markOrderCancelled(randomUUID()));
    expect(await settlement(s.companyId, s.order.orderId)).toMatchObject({ status: 'mismatch' });
  });
});

describe('trạng thái tiền của đơn và chốt lệch (§21.2)', () => {
  it('lệch quá ngưỡng: mismatch; người soạn phí không chốt được; vượt hạn mức cần CEO duyệt rồi Admin khác chốt', async () => {
    const s = await setup();
    await deliver(s);
    await runSettlement(fakeSource(() => settlementOf('M', '-10320.00')), s.companyId, null, s.shopId);
    const p = await get(s.ceo, `/payments/${s.order.orderId}`);
    expect(p.body).toMatchObject({ status: 'mismatch', diff: -10320, needsCeoApproval: true, feeConfigAuthor: { id: s.author.accountId } });
    expect(p.body.statusHistory.map((h: { to: string }) => h.to)).toEqual(['pending', 'mismatch']);
    expect((await get(s.ceo, '/payments?status=mismatch')).body.counts).toMatchObject({ mismatch: 1 });

    const reason = { version: p.body.version, reason: 'Sàn tính phí cố định 8%' };
    const byAuthor = await post(s.author.token, `/payments/${s.order.orderId}/resolve`, reason);
    expect([byAuthor.status, byAuthor.body.type]).toEqual([409, '/problems/second_person_required']);
    const early = await post(s.admin.token, `/payments/${s.order.orderId}/resolve`, reason);
    expect([early.status, early.body.type]).toEqual([409, '/problems/ceo_approval_required']);
    const byAdminApprove = await post(s.admin.token, `/payments/${s.order.orderId}/ceo-approve`, { version: p.body.version });
    expect(byAdminApprove.status).toBe(403);

    const approved = await post(s.ceo, `/payments/${s.order.orderId}/ceo-approve`, { version: p.body.version });
    expect(approved.body).toMatchObject({ status: 'mismatch', needsCeoApproval: false, ceoApproval: { by: { id: expect.any(String) } } });
    const resolved = await post(s.admin.token, `/payments/${s.order.orderId}/resolve`, { ...reason, version: approved.body.version });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({ status: 'resolved', resolved: { reason: 'Sàn tính phí cố định 8%', by: { id: s.admin.accountId } } });

    // Điều chỉnh muộn trong ngưỡng so với mốc lúc chốt: giữ resolved; quá ngưỡng thì mismatch lại.
    await runSettlement(fakeSource(() => [txn('M7', 'Payment Fee', 'Orders-Lazada Fees', '-1000.00')]), s.companyId, null, s.shopId);
    expect((await settlement(s.companyId, s.order.orderId)).status).toBe('resolved');
    await runSettlement(fakeSource(() => [txn('M8', 'Penalty', 'Other', '-9000.00')]), s.companyId, null, s.shopId);
    expect((await settlement(s.companyId, s.order.orderId)).status).toBe('mismatch');
  });

  it('lệch trong hạn mức tự chốt: Admin chốt ngay; CEO duyệt khi không cần thì 409', async () => {
    const s = await setup();
    await deliver(s);
    await runSettlement(fakeSource(() => settlementOf('S', '-9000.00')), s.companyId, null, s.shopId);
    const p = await get(s.ceo, `/payments/${s.order.orderId}`);
    expect(p.body).toMatchObject({ status: 'mismatch', diff: -7680, needsCeoApproval: false });
    const noNeed = await post(s.ceo, `/payments/${s.order.orderId}/ceo-approve`, { version: p.body.version });
    expect([noNeed.status, noNeed.body.type]).toEqual([409, '/problems/approval_not_needed']);
    const noReason = await post(s.admin.token, `/payments/${s.order.orderId}/resolve`, { version: p.body.version, reason: ' ' });
    expect(noReason.status).toBe(422);
    const ok = await post(s.admin.token, `/payments/${s.order.orderId}/resolve`, { version: p.body.version, reason: 'Đã đối chiếu Seller Center' });
    expect(ok.body.status).toBe('resolved');
  });

  it('D42-06s: CEO soạn cấu hình phí rồi tự chốt lệch vượt hạn mức được, đánh dấu tự duyệt trong lịch sử và nhật ký (#249)', async () => {
    const s = await setup();
    const { rows } = await testPool().query(
      `select m.account_id from core.memberships m join core.member_roles r on r.membership_id = m.id
        where m.company_id = $1 and r.role_id = '00000000-0000-4000-8000-000000000001'`,
      [s.companyId],
    );
    const ceoId: string = rows[0].account_id;
    await testPool().query(`update finance.config_versions set created_by = $1 where company_id = $2 and kind = 'fee'`, [ceoId, s.companyId]);
    await deliver(s);
    // Lệch vượt hạn mức tự chốt: CEO chốt luôn, không cần bước duyệt (US-TI-07 dòng 6)
    await runSettlement(fakeSource(() => settlementOf('C', '-10320.00')), s.companyId, null, s.shopId);
    const p = await get(s.ceo, `/payments/${s.order.orderId}`);
    expect(p.body).toMatchObject({ needsCeoApproval: true, feeConfigAuthor: { id: ceoId } });
    const res = await post(s.ceo, `/payments/${s.order.orderId}/resolve`, { version: p.body.version, reason: 'CEO tự đối chiếu' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.resolved).toMatchObject({ by: { id: ceoId }, selfApproved: true });
    expect(res.body.statusHistory.at(-1)).toMatchObject({ to: 'resolved', selfApproved: true });
    const audit = await request(app).get('/api/v1/audit/logs?selfApproved=true').set('Authorization', `Bearer ${s.ceo}`);
    expect(audit.body.items).toContainEqual(
      expect.objectContaining({ entityType: 'finance.order_settlements', entityId: s.order.orderId, selfApproved: true }),
    );
  });

  it('D42-06: Admin khác người soạn phí chốt thì không phải tự duyệt', async () => {
    const s = await setup();
    await deliver(s);
    await runSettlement(fakeSource(() => settlementOf('N', '-9000.00')), s.companyId, null, s.shopId);
    const p = await get(s.admin.token, `/payments/${s.order.orderId}`);
    const res = await post(s.admin.token, `/payments/${s.order.orderId}/resolve`, { version: p.body.version, reason: 'Đã đối chiếu' });
    expect(res.body.resolved).toMatchObject({ selfApproved: false });
    expect(res.body.statusHistory.at(-1)).toMatchObject({ to: 'resolved', selfApproved: false });
  });

  it('D43-Q: Admin chỉ có quyền chốt lệch (không có finance.invoice.view) vẫn xem được đối soát (§21.0)', async () => {
    const s = await setup();
    await setModuleEnabled(s.companyId, 'channel', true);
    const res = await get(s.admin.token, '/settlements');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await get(s.admin.token, '/settlement-lines?shopId=' + s.shopId)).status).not.toBe(403);
    const sale = await addMember(s.companyId, 'sale');
    expect((await get(sale.token, '/settlements')).status).toBe(403);
  });

  it('kéo quyết toán qua API: gian hàng không thuộc công ty thì 404; Sale không xem được trạng thái tiền', async () => {
    const s = await setup();
    const res = await post(s.ceo, '/settlement-runs', { shopId: s.shopId });
    expect([res.status, res.body.type]).toEqual([404, '/problems/not_found']);
    const sale = await addMember(s.companyId, 'sale');
    expect((await get(sale.token, '/payments')).status).toBe(403);
  });
});

describe('kiện giao sau lần quyết toán đầu (#231)', () => {
  it('dòng ước tính của kiện 2 vẫn tính tới khi lần quyết toán sau nối dòng thực tế về đúng dòng đó', async () => {
    const s = await setup();
    await deliver(s);
    await runSettlement(fakeSource(() => settlementOf('A', '-5160.00')), s.companyId, null, s.shopId);
    // Kiện 2: thêm 1 áo giao sau quyết toán; doanh thu 129.000, phí 4% + 2%, giá vốn 60.000.
    await recordPackageDelivered(s.companyId, {
      packageId: randomUUID(),
      orderId: s.order.orderId,
      shopId: s.shopId,
      deliveredAt: '2026-11-04T08:00:00Z',
      lines: [{ variantId: s.variantId, quantity: 1, unitPrice: '129000', unitCost: '60000' }],
      platformSubsidy: '0',
      shippingIncome: '0',
      shippingCost: '0',
    });
    const mid = (await get(s.ceo, `/orders/${s.order.orderId}/profit`)).body;
    expect(mid).toMatchObject({ net: 363780, cogs: -180000, gross: 183780, estimated: true });

    const second = [
      txn('B1', 'Item Price Credit', 'Orders-Sales', '129000.00'),
      txn('B2', 'Commission', 'Orders-Lazada Fees', '-5160.00'),
      txn('B3', 'Payment Fee', 'Orders-Lazada Fees', '-2580.00'),
    ];
    await runSettlement(fakeSource(() => second), s.companyId, null, s.shopId);
    const after = (await get(s.ceo, `/orders/${s.order.orderId}/profit`)).body;
    expect(after).toMatchObject({ net: 363780, cogs: -180000, gross: 183780, estimated: false });
    const list = (await get(s.ceo, '/orders/profits?from=2026-11-01&to=2026-11-30')).body;
    expect(list.items).toMatchObject([{ orderId: s.order.orderId, net: 363780, cogs: -180000, estimated: false }]);
  });
});
