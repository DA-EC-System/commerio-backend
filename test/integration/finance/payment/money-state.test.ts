import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  getOrderPayments,
  initOrderPayment,
  markCodNotCollected,
  markDelivered,
  markRefundPending,
} from '#src/modules/finance/payment/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { createOrder } from '../../helpers/sales.ts';

// Hàm ranh giới trạng thái tiền cho fulfillment #25 (Documents/21 §11, §12.2, T30; plan #27 AC-1…AC-4, A10).
// Trạng thái `paid`, `cod_collected` dựng bằng SQL vì `markPaid`, `markCodCollected` thuộc PR sau của #27 (L004).

async function orderOf(paymentMethod: 'prepaid' | 'cod' = 'prepaid', companyId?: string) {
  const cid = companyId ?? (await createCompany()).companyId;
  const { variantId } = await createVariant(cid);
  const order = await createOrder(cid, { lines: [{ variantId, quantity: 1, unitPrice: 150000 }], paymentMethod });
  return { companyId: cid, orderId: order.orderId };
}

async function confirmed(paymentMethod: 'prepaid' | 'cod' = 'prepaid') {
  const o = await orderOf(paymentMethod);
  await withCompany(o.companyId, () => initOrderPayment(o.orderId, paymentMethod));
  return o;
}

const setStatus = (orderId: string, status: string, refundStatus = 'none') =>
  testPool().query('update finance.order_payments set status = $2, refund_status = $3 where order_id = $1', [
    orderId,
    status,
    refundStatus,
  ]);

const row = async (orderId: string) =>
  (
    await testPool().query(
      'select status, refund_status, delivered_at, version, updated_at > created_at as touched from finance.order_payments where order_id = $1',
      [orderId],
    )
  ).rows[0];

describe('markRefundPending (AC-1)', () => {
  it('đơn đã thu (paid) → pending_refund, ghi updated_at, trả trạng thái mới', async () => {
    const o = await confirmed();
    await setStatus(o.orderId, 'paid');
    const state = await withCompany(o.companyId, () => markRefundPending(o.orderId));
    expect(state).toMatchObject({ orderId: o.orderId, method: 'prepaid', status: 'paid', refundStatus: 'pending_refund' });
    expect(state.amount.toFixed(0)).toBe('150000');
    expect(await row(o.orderId)).toMatchObject({ status: 'paid', refund_status: 'pending_refund', version: 2, touched: true });
  });

  it('gọi lại khi đã pending_refund: trả nguyên, không ghi', async () => {
    const o = await confirmed();
    await setStatus(o.orderId, 'paid', 'pending_refund');
    const state = await withCompany(o.companyId, () => markRefundPending(o.orderId));
    expect(state.refundStatus).toBe('pending_refund');
    expect(await row(o.orderId)).toMatchObject({ version: 1 });
  });

  it('đơn chưa thu (unpaid, cod_pending, not_collected): không có gì để hoàn, trả nguyên, không ghi', async () => {
    for (const [method, status] of [
      ['prepaid', 'unpaid'],
      ['cod', 'cod_pending'],
      ['cod', 'not_collected'],
    ] as const) {
      const o = await confirmed(method);
      await setStatus(o.orderId, status);
      const state = await withCompany(o.companyId, () => markRefundPending(o.orderId));
      expect(state).toMatchObject({ status, refundStatus: 'none' });
      expect(await row(o.orderId)).toMatchObject({ refund_status: 'none', version: 1 });
    }
  });

  it('đơn chưa xác nhận (chưa có dòng): trả trạng thái suy từ đơn, không tạo dòng', async () => {
    const prepaid = await orderOf('prepaid');
    const cod = await orderOf('cod');
    expect(await withCompany(prepaid.companyId, () => markRefundPending(prepaid.orderId))).toMatchObject({
      status: 'unpaid',
      refundStatus: 'none',
      paidAt: null,
    });
    expect(await withCompany(cod.companyId, () => markRefundPending(cod.orderId))).toMatchObject({ status: 'cod_pending' });
    expect(await row(prepaid.orderId)).toBeUndefined();
  });

  it('đơn COD đã thu (cod_collected) → 409 payment_state_changed kèm current, không đổi', async () => {
    const o = await confirmed('cod');
    await setStatus(o.orderId, 'cod_collected');
    await expect(withCompany(o.companyId, () => markRefundPending(o.orderId))).rejects.toMatchObject({
      status: 409,
      code: 'payment_state_changed',
      extensions: { current: expect.objectContaining({ status: 'cod_collected' }) },
    });
    expect(await row(o.orderId)).toMatchObject({ refund_status: 'none', version: 1 });
  });

  it('đơn sàn, đơn công ty khác, id lạ → 404 not_found', async () => {
    const { companyId } = await createCompany();
    const { variantId } = await createVariant(companyId);
    const market = await createOrder(companyId, { lines: [{ variantId, quantity: 1, unitPrice: 1000 }], source: 'marketplace' });
    const other = await confirmed();
    for (const orderId of [market.orderId, other.orderId, randomUUID(), 'khong-phai-uuid']) {
      await expect(withCompany(companyId, () => markRefundPending(orderId))).rejects.toMatchObject({ status: 404 });
    }
  });

  it('đi theo giao dịch bên gọi: rollback thì không đổi', async () => {
    const o = await confirmed();
    await setStatus(o.orderId, 'paid');
    await expect(
      withCompany(o.companyId, async () => {
        await markRefundPending(o.orderId);
        throw new Error('huỷ đơn lỗi');
      }),
    ).rejects.toThrow('huỷ đơn lỗi');
    expect(await row(o.orderId)).toMatchObject({ refund_status: 'none' });
  });
});

describe('markCodNotCollected (AC-2)', () => {
  it('cod_pending → not_collected; gọi lại trả nguyên', async () => {
    const o = await confirmed('cod');
    expect(await withCompany(o.companyId, () => markCodNotCollected(o.orderId))).toMatchObject({ status: 'not_collected' });
    expect(await withCompany(o.companyId, () => markCodNotCollected(o.orderId))).toMatchObject({ status: 'not_collected' });
    expect(await row(o.orderId)).toMatchObject({ status: 'not_collected', version: 2 });
  });

  it('đơn trả trước: không phải COD, trả nguyên, không ghi', async () => {
    const o = await confirmed('prepaid');
    expect(await withCompany(o.companyId, () => markCodNotCollected(o.orderId))).toMatchObject({ status: 'unpaid' });
    expect(await row(o.orderId)).toMatchObject({ status: 'unpaid', version: 1 });
  });

  it('cod_collected → 409 payment_state_changed', async () => {
    const o = await confirmed('cod');
    await setStatus(o.orderId, 'cod_collected');
    await expect(withCompany(o.companyId, () => markCodNotCollected(o.orderId))).rejects.toMatchObject({
      status: 409,
      code: 'payment_state_changed',
    });
  });

  it('đơn COD chưa xác nhận (chưa có dòng): không tạo dòng (tab COD chỉ đọc dòng đã có), trả trạng thái suy từ đơn', async () => {
    const o = await orderOf('cod');
    expect(await withCompany(o.companyId, () => markCodNotCollected(o.orderId))).toMatchObject({ status: 'cod_pending' });
    expect(await row(o.orderId)).toBeUndefined();
  });
});

describe('markDelivered (AC-3)', () => {
  it('ghi delivered_at lần đầu, gọi lại không đổi', async () => {
    const o = await confirmed('cod');
    const first = new Date('2026-10-18T03:00:00Z');
    await withCompany(o.companyId, () => markDelivered(o.orderId, first));
    await withCompany(o.companyId, () => markDelivered(o.orderId, new Date('2026-10-19T03:00:00Z')));
    expect((await row(o.orderId)).delivered_at.toISOString()).toBe(first.toISOString());
  });

  it('đơn không có dòng (đơn sàn) → không làm gì', async () => {
    const { companyId } = await createCompany();
    const { variantId } = await createVariant(companyId);
    const market = await createOrder(companyId, { lines: [{ variantId, quantity: 1, unitPrice: 1000 }], source: 'marketplace' });
    await withCompany(companyId, () => markDelivered(market.orderId, new Date()));
    expect(await row(market.orderId)).toBeUndefined();
  });
});

describe('getOrderPayments (AC-4)', () => {
  it('trả trạng thái tiền theo lô; đơn không có dòng, công ty khác, id lạ không có trong kết quả', async () => {
    const a = await confirmed('cod');
    const prepaid = await orderOf('prepaid', a.companyId);
    await withCompany(a.companyId, () => initOrderPayment(prepaid.orderId, 'prepaid'));
    await setStatus(prepaid.orderId, 'paid');
    const unconfirmed = await orderOf('prepaid', a.companyId);
    const other = await confirmed();
    const map = await withCompany(a.companyId, () =>
      getOrderPayments([a.orderId, prepaid.orderId, unconfirmed.orderId, other.orderId, randomUUID(), 'x']),
    );
    expect([...map.keys()].toSorted()).toEqual([a.orderId, prepaid.orderId].toSorted());
    expect(map.get(a.orderId)).toMatchObject({ method: 'cod', status: 'cod_pending', refundStatus: 'none' });
    expect(map.get(prepaid.orderId)).toMatchObject({ method: 'prepaid', status: 'paid' });
    expect(map.get(prepaid.orderId)!.amount.toFixed(0)).toBe('150000');
  });
});
