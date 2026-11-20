// Hoàn tiền khách tối đa bằng doanh thu đã ghi của các dòng trả (#355; Documents/25 mục 10.1, E174; 21 §11.3): phần vượt
// không ghi sổ, yêu cầu trả bật Cần xử lý qua `flagReturnForReview` của sales.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { recordPackageDelivered, recordReturnRefunded } from '#src/modules/finance/finance/service/ledger.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { createOrder } from '../../helpers/sales.ts';
import { createReturnRequest } from './return-helpers.ts';

async function setup() {
  const c = await createCompany();
  const v = await createVariant(c.companyId);
  const order = await createOrder(c.companyId, { lines: [{ variantId: v.variantId, quantity: 2, unitPrice: 100000 }], source: 'marketplace' });
  const shopId = randomUUID();
  const deliver = async () => {
    const packageId = randomUUID();
    await recordPackageDelivered(c.companyId, {
      packageId,
      orderId: order.orderId,
      shopId,
      deliveredAt: '2026-11-04T08:00:00Z',
      lines: [{ variantId: v.variantId, quantity: 2, unitPrice: '100000', unitCost: '60000' }],
      platformSubsidy: '0',
      shippingIncome: '0',
      shippingCost: '0',
    });
    return packageId;
  };
  const request = (packageId: string | null, quantity: number) =>
    createReturnRequest(c.companyId, { orderId: order.orderId, packageId, quantity, unitPrice: 100000 }).then((r) => r.returnRequestId);
  const refund = (returnRequestId: string, refundAmount: string) =>
    recordReturnRefunded(c.companyId, { returnRequestId, orderId: order.orderId, shopId, refundAmount, refundedAt: '2026-11-05T02:00:00Z' });
  return { companyId: c.companyId, orderId: order.orderId, deliver, request, refund };
}

async function refundRows(returnRequestId: string) {
  const { rows } = await testPool().query<{ kind: string; amount: string }>(
    `select kind, amount from finance.ledger_entries where source_type = 'return_refund' and source_id = $1 order by kind::text`,
    [returnRequestId],
  );
  return rows.map((r) => [r.kind, r.amount]);
}

async function flagOf(returnRequestId: string) {
  const { rows } = await testPool().query<{ needs_attention: boolean; attention_note: string | null }>(
    'select needs_attention, attention_note from "order".return_requests where id = $1',
    [returnRequestId],
  );
  return rows[0]!;
}

const auditCount = async (returnRequestId: string) =>
  (await testPool().query(`select 1 from core.audit_logs where entity_type = 'order.return_requests' and entity_id = $1`, [returnRequestId])).rowCount;

describe('trần ghi hoàn tiền (#355)', () => {
  it('đơn COD hoàn về (chưa có doanh thu): không ghi hoàn tiền, yêu cầu bật Cần xử lý, nhật ký; sự kiện giao lại không ghi thêm', async () => {
    const s = await setup();
    const id = await s.request(randomUUID(), 1);
    expect(await s.refund(id, '110000')).toBe(0);
    expect(await refundRows(id)).toEqual([]);
    const note =
      'Sàn báo hoàn 110.000 ₫ vượt doanh thu đã ghi của phần trả (0 ₫); phần vượt 110.000 ₫ không ghi sổ (kiện chưa giao hoặc COD hoàn về), đối chiếu với sàn';
    expect(await flagOf(id)).toEqual({ needs_attention: true, attention_note: note });
    expect(await auditCount(id)).toBe(1);

    expect(await s.refund(id, '110000')).toBe(0);
    expect(await refundRows(id)).toEqual([]);
    expect((await flagOf(id)).attention_note).toBe(note);
    expect(await auditCount(id)).toBe(1);
  });

  it('trả một món sau khi giao: ghi đủ, không cờ', async () => {
    const s = await setup();
    const id = await s.request(await s.deliver(), 1);
    expect(await s.refund(id, '100000')).toBe(1);
    expect(await refundRows(id)).toEqual([['customer_refund', '-100000.00']]);
    expect((await flagOf(id)).needs_attention).toBe(false);
  });

  it('hai yêu cầu cùng đơn vượt tổng doanh thu: yêu cầu sau chỉ ghi phần còn lại, bật cờ', async () => {
    const s = await setup();
    const pkg = await s.deliver();
    const first = await s.request(pkg, 2);
    const second = await s.request(pkg, 1);
    await s.refund(first, '150000');
    await s.refund(second, '100000');
    expect(await refundRows(first)).toEqual([['customer_refund', '-150000.00']]);
    expect(await refundRows(second)).toEqual([['customer_refund', '-50000.00']]);
    expect((await flagOf(first)).needs_attention).toBe(false);
    expect((await flagOf(second)).attention_note).toBe(
      'Sàn báo hoàn 100.000 ₫ vượt doanh thu đã ghi của phần trả (50.000 ₫); phần vượt 50.000 ₫ không ghi sổ (kiện chưa giao hoặc COD hoàn về), đối chiếu với sàn',
    );
  });

  it('dòng trả chưa gắn kiện: không ghi dù đơn đã có doanh thu', async () => {
    const s = await setup();
    await s.deliver();
    const id = await s.request(null, 1);
    expect(await s.refund(id, '100000')).toBe(0);
    expect((await flagOf(id)).needs_attention).toBe(true);
  });

  it('cờ của luồng khác đang bật: nối lý do vào câu cũ, không xoá', async () => {
    const s = await setup();
    const id = await s.request(randomUUID(), 1);
    await testPool().query(`update "order".return_requests set needs_attention = true, attention_note = 'Sàn báo X' where id = $1`, [id]);
    await s.refund(id, '100000');
    expect((await flagOf(id)).attention_note).toMatch(/^Sàn báo X\. Sàn báo hoàn 100\.000 ₫ vượt/);
  });
});
