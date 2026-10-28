import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cancelActiveLink, initOrderPayment } from '#src/modules/finance/payment/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';

// Hàm ranh giới payment cho fulfillment #25 (Documents/21 §11, D15, QT-36; plan #23 A14). Gọi trong withCompany của bên gọi.
const orderPayment = async (orderId: string) =>
  (await testPool().query('select company_id, status, refund_status from payment.order_payments where order_id = $1', [orderId]))
    .rows[0];

async function insertLink(companyId: string, orderId: string, status = 'active') {
  const code = `CM${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
  const r = await testPool().query<{ id: string }>(
    `insert into payment.payment_links (company_id, order_id, gateway, payment_code, amount, expires_at, status)
     values ($1, $2, 'vietqr', $3, 150000, now() + interval '15 minutes', $4) returning id`,
    [companyId, orderId, code, status],
  );
  return r.rows[0]!.id;
}

const linkStatus = async (id: string) =>
  (await testPool().query('select status, version from payment.payment_links where id = $1', [id])).rows[0];

describe('initOrderPayment (AC-26)', () => {
  it('đơn trả trước tạo dòng unpaid, đơn COD tạo cod_pending; gọi lại không đổi gì', async () => {
    const { companyId } = await createCompany();
    const prepaid = randomUUID();
    const cod = randomUUID();
    await withCompany(companyId, async () => {
      await initOrderPayment(prepaid, 'prepaid');
      await initOrderPayment(cod, 'cod');
      await initOrderPayment(prepaid, 'cod');
    });
    expect(await orderPayment(prepaid)).toEqual({ company_id: companyId, status: 'unpaid', refund_status: 'none' });
    expect(await orderPayment(cod)).toMatchObject({ status: 'cod_pending' });
  });

  it('đi theo giao dịch của bên gọi: bên gọi rollback thì không còn dòng', async () => {
    const { companyId } = await createCompany();
    const orderId = randomUUID();
    await expect(
      withCompany(companyId, async () => {
        await initOrderPayment(orderId, 'prepaid');
        throw new Error('bên gọi lỗi');
      }),
    ).rejects.toThrow('bên gọi lỗi');
    expect(await orderPayment(orderId)).toBeUndefined();
  });

  it('gọi ngoài withCompany là lỗi lập trình', async () => {
    await expect(initOrderPayment(randomUUID(), 'prepaid')).rejects.toThrow(/withCompany/);
  });
});

describe('cancelActiveLink (AC-26)', () => {
  it('mã active của đơn thành cancelled, mã khác của đơn không đổi', async () => {
    const { companyId } = await createCompany();
    const orderId = randomUUID();
    const expired = await insertLink(companyId, orderId, 'expired');
    const active = await insertLink(companyId, orderId);
    await withCompany(companyId, () => cancelActiveLink(orderId));
    expect(await linkStatus(active)).toEqual({ status: 'cancelled', version: 2 });
    expect(await linkStatus(expired)).toEqual({ status: 'expired', version: 1 });
  });

  it('đơn không có mã active thì không làm gì; công ty khác không huỷ được mã', async () => {
    const a = await createCompany();
    const b = await createCompany();
    const orderId = randomUUID();
    await withCompany(a.companyId, () => cancelActiveLink(randomUUID()));
    const active = await insertLink(a.companyId, orderId);
    await withCompany(b.companyId, () => cancelActiveLink(orderId));
    expect((await linkStatus(active)).status).toBe('active');
  });

  it('bên gọi rollback thì mã vẫn active', async () => {
    const { companyId } = await createCompany();
    const orderId = randomUUID();
    const active = await insertLink(companyId, orderId);
    await expect(
      withCompany(companyId, async () => {
        await cancelActiveLink(orderId);
        throw new Error('bên gọi lỗi');
      }),
    ).rejects.toThrow('bên gọi lỗi');
    expect((await linkStatus(active)).status).toBe('active');
  });
});
