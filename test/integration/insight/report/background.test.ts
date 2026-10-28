import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { describe, expect, it, vi } from 'vitest';
import { linkedOrder, verified } from '../../finance/finance/helpers.ts';
import { registerCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { invoice, issuedOrder, refund, settlementLine } from './helpers.ts';
import { handleVerifiedPayment, issueInvoiceForOrder } from '#src/modules/finance/finance/index.ts';
import { vnDay } from '#src/modules/insight/report/domain/days.ts';
import { findCompaniesWithSummary } from '#src/modules/insight/report/repository/summary.ts';
import { onSourceEvent, sweep } from '#src/modules/insight/report/service/background.ts';
import { recompute } from '#src/modules/insight/report/service/recompute.ts';
import type { EventEnvelope } from '#src/modules/core/platform/index.ts';
import { withCompany } from '#src/shared/db/client.ts';

vi.hoisted(() => {
  process.env.PAYMENT_CREDENTIALS_KEY = Buffer.alloc(32, 9).toString('base64');
});

// Đường kích hoạt tính lại (plan #29 lát 4, A5; AC-5, AC-18). Consumer thật chạy trong worker qua Kafka; ở đây gọi
// handler như consumer `shared` gọi: trong withCompany của sự kiện, với envelope dựng từ dòng outbox thật.

async function outboxEnvelopes(companyId: string): Promise<EventEnvelope[]> {
  const { rows } = await testPool().query(
    `select event_id, type, company_id, key, created_at, payload from platform.outbox_messages
      where company_id = $1 and type like 'finance.%' order by id`,
    [companyId],
  );
  return rows.map((r) => ({
    eventId: r.event_id,
    type: r.type,
    companyId: r.company_id,
    aggregateId: r.key,
    occurredAt: r.created_at.toISOString(),
    payload: r.payload,
  }));
}

const consume = (e: EventEnvelope) => withCompany(e.companyId!, () => onSourceEvent(e as Parameters<typeof onSourceEvent>[0]));

async function summary(companyId: string) {
  const { rows } = await testPool().query(
    `select to_char(day, 'YYYY-MM-DD') as day, source, revenue, cash_collected, payment_fee, platform_fee, fees_pending
       from report.daily_channel_summary where company_id = $1 order by day, source`,
    [companyId],
  );
  return rows;
}

describe('consumer báo cáo (AC-5)', () => {
  it('hoá đơn và phiếu thu của #27 (đường thật) → dòng của ngày được tính lại; giao lặp không đổi số', async () => {
    const l = await linkedOrder('vietqr', 150000);
    await withCompany(l.companyId, () => handleVerifiedPayment(verified(l, { fee: new Decimal(1100) })));
    await withCompany(l.companyId, () => issueInvoiceForOrder(l.orderId));
    const events = await outboxEnvelopes(l.companyId);
    expect(events.map((e) => e.type)).toEqual(['finance.receipt_posted', 'finance.invoice_posted']);

    for (const e of events) await consume(e);
    // Ngày của chứng từ lấy từ chính sự kiện (không dùng "hôm nay": chạy qua nửa đêm giờ VN thì lệch).
    const today = vnDay((events[0]!.payload as { postedAt: string }).postedAt);
    const expected = [
      { day: today, source: 'manual', revenue: '150000.00', cash_collected: '150000.00', payment_fee: '1100.00', platform_fee: '0.00', fees_pending: false },
    ];
    expect(await summary(l.companyId)).toEqual(expected);
    for (const e of [...events, ...events]) await consume(e);
    expect(await summary(l.companyId)).toEqual(expected);
  });

  it('phiếu chi hoàn tiền (finance.voucher_posted, #27 phần 3 chưa phát: envelope dựng tay) → trừ tiền đã thu ngày paidOn', async () => {
    const { companyId } = await registerCompany();
    const order = await issuedOrder(companyId, { unitCost: 1000, unitPrice: 50000 });
    const voucherId = await refund(companyId, order.orderId, 50000, '2026-10-21');
    await consume({
      eventId: randomUUID(),
      type: 'finance.voucher_posted',
      companyId,
      aggregateId: voucherId,
      occurredAt: '2026-10-21T03:00:00Z',
      payload: { voucherId, purpose: 'customer_refund', orderId: order.orderId, amount: '50000.00', paidOn: '2026-10-21', reversalOf: null },
    });
    expect(await summary(companyId)).toEqual([
      { day: '2026-10-21', source: 'manual', revenue: '0.00', cash_collected: '-50000.00', payment_fee: '0.00', platform_fee: '0.00', fees_pending: false },
    ]);
  });
});

describe('vòng quét (AC-18)', () => {
  it('dòng đối soát thêm sau (không có sự kiện) vào báo cáo ở lượt quét kế; ngoài 60 ngày không đụng', async () => {
    const { companyId } = await registerCompany();
    const order = await issuedOrder(companyId, { unitCost: 1000, unitPrice: 100000, source: 'marketplace' });
    await invoice(companyId, order.orderId, 100000, '2026-10-18T03:00:00Z');
    await recompute(companyId, '2026-10-18', '2026-10-18');
    expect((await summary(companyId))[0]).toMatchObject({ platform_fee: '0.00', fees_pending: true });

    await settlementLine(companyId, order.orderId, { fees: { commission: 7000 } });
    await sweep([companyId], '2026-12-18');
    expect((await summary(companyId))[0]).toMatchObject({ platform_fee: '0.00', fees_pending: true });
    await sweep([companyId], '2026-10-20');
    expect((await summary(companyId))[0]).toMatchObject({ platform_fee: '7000.00', fees_pending: false });
  });

  it('danh sách công ty để quét là công ty đã có dòng trong bảng', async () => {
    const withRows = await registerCompany();
    const without = await registerCompany();
    const order = await issuedOrder(withRows.companyId, { unitCost: 1000, unitPrice: 2000 });
    await invoice(withRows.companyId, order.orderId, 2000, '2026-10-18T03:00:00Z');
    await recompute(withRows.companyId, '2026-10-18', '2026-10-18');
    const companies = await findCompaniesWithSummary();
    expect(companies).toContain(withRows.companyId);
    expect(companies).not.toContain(without.companyId);
  });
});
