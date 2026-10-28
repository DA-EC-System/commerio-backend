import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { testPool } from '../../helpers/db.ts';
import { asCompany } from '../../helpers/rls.ts';

const insertLink = (companyId: string, orderId: string, paymentCode: string, status = 'active') =>
  testPool().query(
    `insert into finance.payment_links (company_id, order_id, gateway, payment_code, amount, expires_at, status)
     values ($1, $2, 'vnpay', $3, 150000, now() + interval '15 minutes', $4)`,
    [companyId, orderId, paymentCode, status],
  );

const code = () => `CM${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;

// Ràng buộc của payment (plan chuẩn bị 4.2, 4.3, A7; D14, D16; 19-D21; AC-9).
describe('ràng buộc bảng payment (AC-9)', () => {
  it('mỗi đơn tối đa một mã active; mã đã hết hạn thì tạo mã mới được (19-D21)', async () => {
    const company = randomUUID();
    const order = randomUUID();
    await insertLink(company, order, code(), 'expired');
    await insertLink(company, order, code());
    await expect(insertLink(company, order, code())).rejects.toThrow(/payment_links_one_active_per_order/);
  });

  it('mã thanh toán unique toàn hệ thống, kể cả khác công ty (D14)', async () => {
    const shared = code();
    await insertLink(randomUUID(), randomUUID(), shared);
    await expect(insertLink(randomUUID(), randomUUID(), shared)).rejects.toThrow(/payment_links_payment_code_unique/);
  });

  it('giao dịch cổng không trùng theo (cổng, mã giao dịch) toàn hệ thống (A7)', async () => {
    const txn = `TXN-${randomUUID()}`;
    const insertTxn = (companyId: string, gateway: string) =>
      testPool().query(
        `insert into finance.payment_transactions (company_id, gateway, gateway_txn_id, amount, source, occurred_at)
         values ($1, $2, $3, 150000, 'webhook', now())`,
        [companyId, gateway, txn],
      );
    await insertTxn(randomUUID(), 'momo');
    await expect(insertTxn(randomUUID(), 'momo')).rejects.toThrow(/payment_transactions_gateway_gateway_txn_id_unique/);
    await expect(insertTxn(randomUUID(), 'zalopay')).resolves.toBeDefined();
  });

  it('khoá nhận webhook SePay unique toàn hệ thống (D16)', async () => {
    const key = randomUUID().replaceAll('-', '');
    const insert = () =>
      testPool().query(
        "insert into finance.gateway_configs (company_id, gateway, webhook_receiver_key) values ($1, 'vietqr', $2)",
        [randomUUID(), key],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/gateway_configs_webhook_receiver_key_unique/);
  });

  it('webhook trùng mã sự kiện của cùng cổng bị từ chối, khác cổng thì được', async () => {
    const company = randomUUID();
    const insert = (gateway: string) =>
      testPool().query(
        `insert into finance.webhook_events (company_id, gateway, event_key, payload) values ($1, $2, '1001', '{}')`,
        [company, gateway],
      );
    await insert('vnpay');
    await expect(insert('vnpay')).rejects.toThrow(/duplicate key/);
    await expect(insert('momo')).resolves.toBeDefined();
  });

  it('trạng thái tiền của đơn: chỉ thấy của công ty mình; mặc định chưa hoàn, chưa giao', async () => {
    const company = randomUUID();
    const order = randomUUID();
    await testPool().query(
      "insert into finance.order_payments (order_id, company_id, status) values ($1, $2, 'cod_pending')",
      [order, company],
    );
    const own = await asCompany(company, (c) =>
      c.query('select refund_status, paid_at, delivered_at from finance.order_payments where order_id = $1', [order]),
    );
    expect(own.rows).toEqual([{ refund_status: 'none', paid_at: null, delivered_at: null }]);
    const other = await asCompany(randomUUID(), (c) =>
      c.query('select 1 from finance.order_payments where order_id = $1', [order]),
    );
    expect(other.rowCount).toBe(0);
  });
});
