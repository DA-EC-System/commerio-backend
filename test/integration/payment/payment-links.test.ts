import { afterEach, describe, expect, it, vi } from 'vitest';
import { addMember, createCompany } from '../helpers/company.ts';
import { testPool } from '../helpers/db.ts';
import { createLink as create, linksOf, order, orderPaymentOf, shop } from './helpers.ts';

vi.hoisted(() => {
  process.env.PAYMENT_CREDENTIALS_KEY = Buffer.alloc(32, 9).toString('base64');
});

// Tạo mã QR/link (commerio-backend#23 PR2, UC-PF-01; Documents/21 §12.3, §12.8, §12.9, T9, T10; plan A7, A9).
// Cổng gọi mạng (MoMo, ZaloPay) dùng fetch giả; VietQR, VNPay không gọi mạng.

const MOMO_OK = { resultCode: 0, payUrl: 'https://test-payment.momo.vn/v2/gateway/pay?t=abc', qrCodeUrl: 'momo://app?isScanQR=true' };
const momoReturns = (status: number, body: unknown) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(body), { status }));

const count = async (sql: string, id: string) => Number((await testPool().query(sql, [id])).rows[0].count);
const auditCount = (companyId: string) =>
  count("select count(*) from audit.audit_logs where company_id = $1 and entity_type = 'payment.payment_links'", companyId);

afterEach(() => vi.restoreAllMocks());

describe('POST /payment/orders/:orderId/links', () => {
  it('Sale tạo mã VietQR cho đơn trả trước chưa thu → 201; DB một mã active, có dòng unpaid, nhật ký (AC-12, AC-22, AC-25)', async () => {
    const s = await shop('vietqr');
    const o = await order(s);
    const before = Date.now();
    const res = await create(s.sale.token, o.orderId, 'vietqr');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      orderId: o.orderId,
      gateway: 'vietqr',
      amount: 150000,
      payUrl: null,
      status: 'active',
      createdBy: { id: s.sale.accountId, name: 'Nhân Viên Thử' },
      bankTransfer: {
        bankBin: '970422',
        bankName: 'MB Bank',
        accountNo: '0123456789',
        accountName: 'CONG TY THU',
        content: res.body.paymentCode,
      },
    });
    expect(res.body.paymentCode).toMatch(/^CM[A-HJKMNP-Z2-9]{10}$/);
    expect(res.body.qrContent).toContain(`0812${res.body.paymentCode}`);
    const ttl = new Date(res.body.expiresAt).getTime() - before;
    expect(ttl).toBeGreaterThan(14 * 60_000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000 + 5_000);

    const links = await linksOf(o.orderId);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ id: res.body.id, status: 'active', amount: '150000.00', payment_code: res.body.paymentCode });
    expect(await orderPaymentOf(o.orderId)).toEqual({ status: 'unpaid', refund_status: 'none' });
    const audit = await testPool().query(
      "select action, actor_id, after from audit.audit_logs where entity_type = 'payment.payment_links' and entity_id = $1",
      [res.body.id],
    );
    expect(audit.rows).toEqual([
      {
        action: 'create',
        actor_id: s.sale.accountId,
        after: { orderId: o.orderId, gateway: 'vietqr', paymentCode: res.body.paymentCode, amount: 150000, expiresAt: res.body.expiresAt },
      },
    ]);
  });

  it('MoMo: gọi cổng một lần, trả payUrl và qrContent của cổng (AC-12, AC-20 phần dựng)', async () => {
    const s = await shop('momo');
    const o = await order(s);
    const spy = momoReturns(200, MOMO_OK);
    const res = await create(s.sale.token, o.orderId, 'momo');
    expect(res.status).toBe(201);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(res.body).toMatchObject({ payUrl: MOMO_OK.payUrl, qrContent: MOMO_OK.qrCodeUrl, bankTransfer: null });
    expect((await linksOf(o.orderId))[0].gateway_order_ref).toBe(res.body.paymentCode);
  });

  it('đơn đã có mã còn hạn → 200 trả đúng mã đó, kể cả gửi cổng khác, không gọi cổng (AC-13)', async () => {
    const s = await shop('vietqr', 'momo');
    const o = await order(s);
    const first = await create(s.sale.token, o.orderId, 'vietqr');
    const spy = vi.spyOn(globalThis, 'fetch');
    const again = await create(s.sale.token, o.orderId, 'momo');
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(spy).not.toHaveBeenCalled();
    expect(await linksOf(o.orderId)).toHaveLength(1);
    expect(await auditCount(s.companyId)).toBe(1);
  });

  it('mã active đã quá hạn → 201 mã mới, mã cũ thành expired (AC-14)', async () => {
    const s = await shop('vietqr');
    const o = await order(s);
    const first = await create(s.sale.token, o.orderId, 'vietqr');
    // Lùi hạn bằng SQL (dựng tay, L004): trong sản phẩm là 15 phút trôi qua.
    await testPool().query("update payment.payment_links set expires_at = now() - interval '1 minute' where id = $1", [first.body.id]);
    const second = await create(s.sale.token, o.orderId, 'vietqr');
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);
    const links = await linksOf(o.orderId);
    expect(links.map((l: { status: string }) => l.status)).toEqual(['expired', 'active']);
  });

  it('hai yêu cầu song song cho cùng đơn → một mã active, một 201 và một 200 cùng id (AC-15)', async () => {
    const s = await shop('vietqr');
    const o = await order(s);
    const [a, b] = await Promise.all([create(s.sale.token, o.orderId, 'vietqr'), create(s.sale.token, o.orderId, 'vietqr')]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.id).toBe(b.body.id);
    expect((await linksOf(o.orderId)).filter((l: { status: string }) => l.status === 'active')).toHaveLength(1);
  });

  describe('409 payment_not_allowed, không ghi, không gọi cổng (AC-16)', () => {
    it.each([
      ['đơn COD', { paymentMethod: 'cod' as const }],
      ['đơn sàn', { source: 'marketplace' as const }],
    ])('%s', async (_name, options) => {
      const s = await shop('momo');
      const o = await order(s, 150000, options);
      const spy = vi.spyOn(globalThis, 'fetch');
      const res = await create(s.sale.token, o.orderId, 'momo');
      expect(res.status).toBe(409);
      expect(res.body.type).toBe('/problems/payment_not_allowed');
      expect(spy).not.toHaveBeenCalled();
      expect(await linksOf(o.orderId)).toHaveLength(0);
      expect(await orderPaymentOf(o.orderId)).toBeUndefined();
    });

    it('đơn đã thanh toán (dòng paid dựng tay: markPaid là #27)', async () => {
      const s = await shop('vietqr');
      const o = await order(s);
      await testPool().query("insert into payment.order_payments (order_id, company_id, status) values ($1, $2, 'paid')", [
        o.orderId,
        s.companyId,
      ]);
      expect((await create(s.sale.token, o.orderId, 'vietqr')).body.type).toBe('/problems/payment_not_allowed');
    });

    it('đơn đã huỷ (dựng tay: huỷ đơn là #25)', async () => {
      const s = await shop('vietqr');
      const o = await order(s);
      await testPool().query("update sales.orders set status = 'cancelled' where id = $1", [o.orderId]);
      expect((await create(s.sale.token, o.orderId, 'vietqr')).status).toBe(409);
    });

    it('tổng có phần lẻ đồng', async () => {
      const s = await shop('vietqr');
      const o = await order(s, 150000.5);
      expect((await create(s.sale.token, o.orderId, 'vietqr')).body.type).toBe('/problems/payment_not_allowed');
    });
  });

  it('hạn mức MoMo: 999 và 50.000.001 → 409, 1.000 và 50.000.000 → 201; đơn đã có mã VietQR còn hạn gửi momo → 200 (AC-29)', async () => {
    const s = await shop('momo', 'vietqr');
    const spy = momoReturns(200, MOMO_OK);
    for (const [price, status] of [
      [999, 409],
      [50_000_001, 409],
      [1_000, 201],
      [50_000_000, 201],
    ] as const) {
      const o = await order(s, price);
      expect((await create(s.sale.token, o.orderId, 'momo')).status).toBe(status);
    }
    expect(spy).toHaveBeenCalledTimes(2);
    const big = await order(s, 60_000_000);
    const qr = await create(s.sale.token, big.orderId, 'vietqr');
    const again = await create(s.sale.token, big.orderId, 'momo');
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(qr.body.id);
  });

  it('cổng chưa cấu hình → 422 gateway_not_configured kèm errors.gateway, không gọi ra ngoài (AC-17)', async () => {
    const s = await shop('vietqr');
    const o = await order(s);
    const spy = vi.spyOn(globalThis, 'fetch');
    const res = await create(s.sale.token, o.orderId, 'zalopay');
    expect(res.status).toBe(422);
    expect(res.body.type).toBe('/problems/gateway_not_configured');
    expect(res.body.errors).toHaveProperty('gateway');
    expect(spy).not.toHaveBeenCalled();
    const bad = await create(s.sale.token, o.orderId, 'paypal');
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toHaveProperty('gateway');
  });

  it('cổng từ chối, lỗi mạng hoặc quá hạn → 502 gateway_unavailable, không ghi dòng nào (AC-18)', async () => {
    const s = await shop('momo');
    const o = await order(s);
    momoReturns(400, { resultCode: 11007, message: 'Invalid signature. Raw data before hash: accessKey=***' });
    const rejected = await create(s.sale.token, o.orderId, 'momo');
    expect(rejected.status).toBe(502);
    expect(rejected.body.type).toBe('/problems/gateway_unavailable');
    expect(JSON.stringify(rejected.body)).not.toContain('Raw data');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('quá hạn', 'TimeoutError'));
    expect((await create(s.sale.token, o.orderId, 'momo')).status).toBe(502);
    expect(await linksOf(o.orderId)).toHaveLength(0);
    expect(await orderPaymentOf(o.orderId)).toBeUndefined();
    expect(await auditCount(s.companyId)).toBe(0);
  });

  it('đơn bị huỷ trong lúc chờ cổng → 409, không ghi (A7 bước 3)', async () => {
    const s = await shop('momo');
    const o = await order(s);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await testPool().query("update sales.orders set status = 'cancelled' where id = $1", [o.orderId]);
      return new Response(JSON.stringify(MOMO_OK));
    });
    const res = await create(s.sale.token, o.orderId, 'momo');
    expect(res.status).toBe(409);
    expect(await linksOf(o.orderId)).toHaveLength(0);
  });

  it.each([
    ['đơn chưa có dòng order_payments', false],
    ['đơn đã có dòng order_payments', true],
  ])('huỷ đơn chạy song song, giữ khoá dòng đơn: tạo mã chờ rồi 409, không còn mã active (%s)', async (_name, withRow) => {
    const s = await shop('vietqr');
    const o = await order(s);
    if (withRow) {
      await testPool().query("insert into payment.order_payments (order_id, company_id, status) values ($1, $2, 'unpaid')", [
        o.orderId,
        s.companyId,
      ]);
    }
    const holder = await testPool().connect();
    try {
      await holder.query('begin');
      await holder.query("update sales.orders set status = 'cancelled' where id = $1", [o.orderId]);
      const pending = create(s.sale.token, o.orderId, 'vietqr').then((r) => r);
      // Chờ tới khi yêu cầu tạo mã thật sự bị chặn bởi giao dịch huỷ, rồi mới commit.
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        const r = await testPool().query(
          "select count(*)::int n from pg_stat_activity where cardinality(pg_blocking_pids(pid)) > 0 and query ilike '%sales%orders%for share%'",
        );
        blocked = r.rows[0].n > 0;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(blocked).toBe(true);
      await holder.query('commit');
      const res = await pending;
      expect(res.status).toBe(409);
      expect((await linksOf(o.orderId)).filter((l: { status: string }) => l.status === 'active')).toHaveLength(0);
    } finally {
      holder.release();
    }
  });

  it('thiếu token 401, Nhân viên kho 403, đơn công ty khác hoặc id lạ 404 (AC-24)', async () => {
    const s = await shop('vietqr');
    const o = await order(s);
    expect((await create(undefined, o.orderId, 'vietqr')).status).toBe(401);
    const kho = await addMember(s.companyId, 'warehouse');
    expect((await create(kho.token, o.orderId, 'vietqr')).body.type).toBe('/problems/forbidden');
    const other = await createCompany();
    const otherSale = await addMember(other.companyId, 'sale');
    const foreign = await create(otherSale.token, o.orderId, 'vietqr');
    expect(foreign.status).toBe(404);
    expect(foreign.body.type).toBe('/problems/not_found');
    expect((await create(s.sale.token, 'khong-phai-uuid', 'vietqr')).status).toBe(404);
    expect(await linksOf(o.orderId)).toHaveLength(0);
  });
});
