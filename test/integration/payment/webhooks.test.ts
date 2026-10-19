import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { linkedOrder, linkStatus, moneyRows, orderPayment } from '../finance/helpers.ts';
import { testPool } from '../helpers/db.ts';
import { testApp } from '../helpers/http.ts';
import { lockCompany } from '../helpers/state.ts';
import { CREDENTIALS, shop } from './helpers.ts';

vi.hoisted(() => {
  process.env.PAYMENT_CREDENTIALS_KEY = Buffer.alloc(32, 9).toString('base64');
});

// Webhook 4 cổng qua HTTP (Documents/21 §12.4, T6, D16, V20; plan #27 AC-7…AC-13, AC-15, AC-18). Payload ký bằng khoá
// công ty đã lưu qua API (helpers.CREDENTIALS), theo tài liệu chính thức (D1, D3, D5, D7).
afterEach(() => vi.restoreAllMocks());

const hmac = (alg: 'sha256' | 'sha512', key: string, data: string) => createHmac(alg, key).update(data).digest('hex');
const php = (s: string) => encodeURIComponent(s).replace(/%20/g, '+');
const V1 = '/api/v1/payment/webhooks';

function vnpayQuery(paymentCode: string, over: Record<string, string> = {}) {
  const params: Record<string, string> = {
    vnp_Amount: '15000000',
    vnp_BankCode: 'NCB',
    vnp_OrderInfo: 'Thanh toan don',
    vnp_PayDate: '20261018101530',
    vnp_ResponseCode: '00',
    vnp_TmnCode: CREDENTIALS.vnpay.tmnCode,
    vnp_TransactionNo: String(Math.floor(Math.random() * 1e9)),
    vnp_TransactionStatus: '00',
    vnp_TxnRef: paymentCode,
    ...over,
  };
  const data = Object.keys(params)
    .sort()
    .map((k) => `${php(k)}=${php(params[k]!)}`)
    .join('&');
  return { ...params, vnp_SecureHash: hmac('sha512', CREDENTIALS.vnpay.hashSecret, data) };
}

function momoIpn(paymentCode: string, over: Record<string, unknown> = {}) {
  const b = {
    partnerCode: 'MOMO',
    orderId: paymentCode,
    requestId: paymentCode,
    amount: 150000,
    orderInfo: 'Thanh toan don',
    orderType: 'momo_wallet',
    transId: Math.floor(Math.random() * 1e10),
    resultCode: 0,
    message: 'Thành công.',
    payType: 'qr',
    responseTime: Date.now(),
    extraData: '',
    ...over,
  };
  const raw =
    `accessKey=${CREDENTIALS.momo.accessKey}&amount=${b.amount}&extraData=${b.extraData}&message=${b.message}` +
    `&orderId=${b.orderId}&orderInfo=${b.orderInfo}&orderType=${b.orderType}&partnerCode=${b.partnerCode}` +
    `&payType=${b.payType}&requestId=${b.requestId}&responseTime=${b.responseTime}&resultCode=${b.resultCode}&transId=${b.transId}`;
  return { ...b, signature: hmac('sha256', CREDENTIALS.momo.secretKey, raw) };
}

function zalopayCallback(paymentCode: string) {
  const data = JSON.stringify({
    app_id: 2553,
    app_trans_id: `261018_${paymentCode}`,
    app_time: Date.now(),
    app_user: 'commerio',
    amount: 150000,
    embed_data: '{}',
    item: '[]',
    zp_trans_id: Math.floor(Math.random() * 1e12),
    server_time: Date.now(),
    channel: 38,
    merchant_user_id: 'u1',
    user_fee_amount: 0,
    discount_amount: 0,
  });
  return { data, mac: hmac('sha256', CREDENTIALS.zalopay.key2, data), type: 1 };
}

const sepayTx = (content: string, over: Record<string, unknown> = {}) => ({
  id: Math.floor(Math.random() * 1e9),
  gateway: 'MBBank',
  transactionDate: '2026-10-18 10:15:30',
  accountNumber: CREDENTIALS.vietqr.accountNo,
  code: null,
  content,
  transferType: 'in',
  transferAmount: 150000,
  accumulated: 0,
  subAccount: '',
  referenceCode: 'FT1',
  description: '',
  ...over,
});
const receiverKeyOf = async (companyId: string) =>
  (await testPool().query("select webhook_receiver_key k from payment.gateway_configs where company_id = $1 and gateway = 'vietqr'", [companyId]))
    .rows[0].k as string;
const sepay = (key: string, body: unknown, apiKey: string = CREDENTIALS.vietqr.sepayApiKey) =>
  request(testApp()).post(`${V1}/sepay/${key}`).set('Authorization', `Apikey ${apiKey}`).send(body as object);

const nothingWritten = (r: Awaited<ReturnType<typeof moneyRows>>) =>
  expect([r.txns.length, r.events.length, r.receipts.length, r.unmatched.length, r.outbox.length]).toEqual([0, 0, 0, 0, 0]);

describe('GET /payment/webhooks/vnpay (IPN)', () => {
  it('ký đúng, đủ tiền → 200 RspCode 00; đọc lại: phiếu thu, đơn paid, mã paid; gửi lại → 02 (AC-7, AC-13)', async () => {
    const l = await linkedOrder('vnpay');
    const q = vnpayQuery(l.link.paymentCode);
    const res = await request(testApp()).get(`${V1}/vnpay`).query(q);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ RspCode: '00', Message: 'Confirm Success' });
    const r = await moneyRows(l.companyId);
    expect(r.txns).toEqual([expect.objectContaining({ gateway: 'vnpay', source: 'webhook', status: 'succeeded', amount: '150000.00' })]);
    expect(r.receipts).toEqual([expect.objectContaining({ number: 'PT-000001', source: 'gateway' })]);
    expect(await orderPayment(l.orderId)).toMatchObject({ status: 'paid' });
    expect(await linkStatus(l.link.id)).toBe('paid');

    expect((await request(testApp()).get(`${V1}/vnpay`).query(q)).body).toMatchObject({ RspCode: '02' });
    expect((await moneyRows(l.companyId)).receipts).toHaveLength(1);
  });

  it('sai chữ ký → 97, không ghi dòng nào (AC-11)', async () => {
    const l = await linkedOrder('vnpay');
    const res = await request(testApp())
      .get(`${V1}/vnpay`)
      .query({ ...vnpayQuery(l.link.paymentCode), vnp_Amount: '100' });
    expect(res.body).toMatchObject({ RspCode: '97' });
    nothingWritten(await moneyRows(l.companyId));
  });

  it('mã không có, mã của cổng khác, công ty chưa cấu hình cổng → 01, không ghi (AC-12)', async () => {
    expect((await request(testApp()).get(`${V1}/vnpay`).query(vnpayQuery('CMNOTEXIST22'))).body).toMatchObject({ RspCode: '01' });
    expect((await request(testApp()).get(`${V1}/vnpay`)).body).toMatchObject({ RspCode: '01' });

    const viaVietqr = await linkedOrder('vietqr');
    expect((await request(testApp()).get(`${V1}/vnpay`).query(vnpayQuery(viaVietqr.link.paymentCode))).body).toMatchObject({
      RspCode: '01',
    });

    const unconfigured = await linkedOrder('vnpay');
    await testPool().query("delete from payment.gateway_configs where company_id = $1 and gateway = 'vnpay'", [unconfigured.companyId]); // dựng tay
    expect(
      (await request(testApp()).get(`${V1}/vnpay`).query(vnpayQuery(unconfigured.link.paymentCode))).body,
    ).toMatchObject({ RspCode: '01' });
    nothingWritten(await moneyRows(unconfigured.companyId));
  });

  it('lệch tiền → 00 (đã nhận), khoản thu chưa khớp; cổng báo thất bại → 00, giao dịch failed (AC-14, AC-17)', async () => {
    const l = await linkedOrder('vnpay');
    const mismatch = await request(testApp())
      .get(`${V1}/vnpay`)
      .query(vnpayQuery(l.link.paymentCode, { vnp_Amount: '14900000' }));
    expect(mismatch.body).toMatchObject({ RspCode: '00' });
    const failed = await request(testApp())
      .get(`${V1}/vnpay`)
      .query(vnpayQuery(l.link.paymentCode, { vnp_ResponseCode: '24', vnp_TransactionStatus: '02', vnp_TransactionNo: '0' }));
    expect(failed.body).toMatchObject({ RspCode: '00' });
    const r = await moneyRows(l.companyId);
    expect(r.txns.map((t) => t.status).toSorted()).toEqual(['failed', 'needs_review']);
    expect(r.unmatched).toEqual([expect.objectContaining({ reason: 'amount_mismatch' })]);
    expect(await orderPayment(l.orderId)).toMatchObject({ status: 'unpaid' });
  });

  it('công ty đã bị khoá vẫn nhận tiền (AC-18, V20)', async () => {
    const l = await linkedOrder('vnpay');
    await lockCompany(l.companyId);
    expect((await request(testApp()).get(`${V1}/vnpay`).query(vnpayQuery(l.link.paymentCode))).body).toMatchObject({ RspCode: '00' });
    expect(await orderPayment(l.orderId)).toMatchObject({ status: 'paid' });
  });
});

describe('POST /payment/webhooks/momo (IPN)', () => {
  it('ký đúng → 204 không body, đơn paid; gửi lại → 204, vẫn một phiếu thu (AC-8, AC-13)', async () => {
    const l = await linkedOrder('momo');
    const ipn = momoIpn(l.link.paymentCode);
    const res = await request(testApp()).post(`${V1}/momo`).send(ipn);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(await orderPayment(l.orderId)).toMatchObject({ status: 'paid' });
    expect((await request(testApp()).post(`${V1}/momo`).send(ipn)).status).toBe(204);
    expect((await moneyRows(l.companyId)).receipts).toHaveLength(1);
    // Payload lưu lại không có chữ ký (AC-40, A18).
    const stored = await testPool().query(
      'select t.raw_payload, e.payload from payment.payment_transactions t join payment.webhook_events e on e.event_key = t.gateway_txn_id where t.company_id = $1',
      [l.companyId],
    );
    expect(stored.rows[0].raw_payload).not.toHaveProperty('signature');
    expect(stored.rows[0].payload).not.toHaveProperty('signature');
    expect(stored.rows[0].raw_payload).toMatchObject({ orderId: l.link.paymentCode, transId: ipn.transId });
  });

  it('sai chữ ký, mã không có → 400, không ghi (AC-11, AC-12)', async () => {
    const l = await linkedOrder('momo');
    expect((await request(testApp()).post(`${V1}/momo`).send({ ...momoIpn(l.link.paymentCode), amount: 1000 })).status).toBe(400);
    expect((await request(testApp()).post(`${V1}/momo`).send(momoIpn('CMNOTEXIST22'))).status).toBe(400);
    nothingWritten(await moneyRows(l.companyId));
  });
});

describe('POST /payment/webhooks/zalopay (callback)', () => {
  it('mac đúng → return_code 1, đơn paid; gửi lại → 2 (AC-9, AC-13)', async () => {
    const l = await linkedOrder('zalopay');
    const cb = zalopayCallback(l.link.paymentCode);
    expect((await request(testApp()).post(`${V1}/zalopay`).send(cb)).body).toEqual({ return_code: 1, return_message: 'success' });
    expect(await orderPayment(l.orderId)).toMatchObject({ status: 'paid' });
    expect((await request(testApp()).post(`${V1}/zalopay`).send(cb)).body).toMatchObject({ return_code: 2 });
  });

  it('mac sai → -1, không ghi (AC-11)', async () => {
    const l = await linkedOrder('zalopay');
    const res = await request(testApp())
      .post(`${V1}/zalopay`)
      .send({ ...zalopayCallback(l.link.paymentCode), mac: 'ab'.repeat(32) });
    expect(res.body).toMatchObject({ return_code: -1 });
    nothingWritten(await moneyRows(l.companyId));
  });
});

describe('POST /payment/webhooks/sepay/:receiverKey', () => {
  it('API key đúng, nội dung có mã, đủ tiền → 200 success, đơn paid, source sepay (AC-10)', async () => {
    const l = await linkedOrder('vietqr');
    const res = await sepay(await receiverKeyOf(l.companyId), sepayTx(`NGUYEN VAN A ${l.link.paymentCode} FT1`));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect((await moneyRows(l.companyId)).txns).toEqual([expect.objectContaining({ gateway: 'vietqr', source: 'sepay', status: 'succeeded' })]);
    expect(await orderPayment(l.orderId)).toMatchObject({ status: 'paid' });
  });

  it('không có mã, hoặc mã của công ty khác → khoản thu chưa khớp no_payment_code của công ty sở hữu URL (AC-15)', async () => {
    const receiver = await shop('vietqr');
    const other = await linkedOrder('vietqr');
    const key = await receiverKeyOf(receiver.companyId);
    expect((await sepay(key, sepayTx('chuyen tien hang thang'))).body).toEqual({ success: true });
    expect((await sepay(key, sepayTx(`tra ${other.link.paymentCode}`))).body).toEqual({ success: true });
    const r = await moneyRows(receiver.companyId);
    expect(r.unmatched.map((u) => u.reason)).toEqual(['no_payment_code', 'no_payment_code']);
    expect(r.txns.every((t) => t.order_id === null && t.status === 'needs_review')).toBe(true);
    expect(await orderPayment(other.orderId)).toMatchObject({ status: 'unpaid' });
    nothingWritten(await moneyRows(other.companyId));
  });

  it('hai lần chuyển khác nhau cùng mã tới song song: một phiếu thu, bên thua thành khoản thu chưa khớp, cả hai 200 success (#63 B21)', async () => {
    const l = await linkedOrder('vietqr');
    const key = await receiverKeyOf(l.companyId);
    const holder = await testPool().connect();
    try {
      // Giữ khoá dòng order_payments để cả hai webhook cùng đọc `unpaid` rồi cùng chờ ở `markPaid`.
      await holder.query('begin');
      const locked = await holder.query('select status from payment.order_payments where order_id = $1 for update', [l.orderId]);
      expect(locked.rows).toEqual([{ status: 'unpaid' }]);
      const holderPid = (await holder.query('select pg_backend_pid() as pid')).rows[0].pid;
      const pending = [1, 2].map((n) => sepay(key, sepayTx(`CK lan ${n} ${l.link.paymentCode}`)).then((r) => r));
      let blocked = 0;
      for (let i = 0; i < 100 && blocked < 2; i++) {
        // Chỉ đếm phiên chờ sau `holder` (file integration khác chạy song song không làm sai số đếm). Khoá dòng xếp hàng:
        // phiên thứ hai bị phiên thứ nhất chặn, không phải `holder`, nên đếm hai tầng.
        const r = await testPool().query(
          `with direct as (select pid from pg_stat_activity where pg_blocking_pids(pid) @> array[$1]::int[])
           select (select count(*) from direct)::int + (select count(*) from pg_stat_activity
             where pid not in (select pid from direct) and pg_blocking_pids(pid) && array(select pid from direct))::int as n`,
          [holderPid],
        );
        blocked = r.rows[0].n;
        if (blocked < 2) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(blocked).toBe(2);
      await holder.query('commit');
      const replies = await Promise.all(pending);
      expect(replies.map((r) => [r.status, r.body])).toEqual([
        [200, { success: true }],
        [200, { success: true }],
      ]);
    } finally {
      // Assert hỏng giữa chừng thì không trả kết nối còn giữ khoá về pool.
      await holder.query('rollback').catch(() => undefined);
      holder.release();
    }
    const r = await moneyRows(l.companyId);
    expect(r.receipts).toHaveLength(1);
    expect(r.txns.map((t) => t.status).toSorted()).toEqual(['needs_review', 'succeeded']);
    const loser = r.txns.find((t) => t.status === 'needs_review')!;
    expect(r.unmatched).toEqual([
      expect.objectContaining({ reason: 'amount_mismatch', status: 'open', amount: '150000.00', transfer_content: expect.stringContaining(l.link.paymentCode) }),
    ]);
    expect((await testPool().query('select id from payment.payment_transactions where gateway_txn_id = $1', [loser.gateway_txn_id])).rows[0].id).toBe(
      r.unmatched[0]!.payment_transaction_id,
    );
    expect(r.events).toHaveLength(2);
    expect(r.outbox.map((e) => e.type)).toEqual(['payment.succeeded', 'finance.receipt_posted']);
    expect(await orderPayment(l.orderId)).toMatchObject({ status: 'paid' });
    expect(await linkStatus(l.link.id)).toBe('paid');
  });

  it('tiền ra → 200 success, không ghi; sai API key → 401 success:false; receiverKey lạ → 404 (AC-11, AC-12, AC-15)', async () => {
    const l = await linkedOrder('vietqr');
    const key = await receiverKeyOf(l.companyId);
    expect((await sepay(key, sepayTx(l.link.paymentCode, { transferType: 'out' }))).body).toEqual({ success: true });
    const wrong = await sepay(key, sepayTx(l.link.paymentCode), 'SAI-KEY-00000000');
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual({ success: false });
    const unknown = await sepay('khong-co-key-nay', sepayTx(l.link.paymentCode));
    expect(unknown.status).toBe(404);
    nothingWritten(await moneyRows(l.companyId));
  });
});
