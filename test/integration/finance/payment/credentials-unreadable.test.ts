import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { CREDENTIALS, createLink, order, shop } from './helpers.ts';

vi.hoisted(() => {
  process.env.PAYMENT_CREDENTIALS_KEY = Buffer.alloc(32, 9).toString('base64');
  process.env.PUBLIC_API_URL = 'https://api.commerio.test';
});

// Khoá cổng đã lưu không giải mã được (đổi PAYMENT_CREDENTIALS_KEY, bản mã hỏng): không ra 500 (commerio-backend#63 B6).

/** Sửa một byte trong phần bản mã của khoá cổng: GCM từ chối khi giải mã. */
const corrupt = (companyId: string, gateway: string) =>
  testPool().query(
    `update finance.gateway_configs set credentials_enc = set_byte(credentials_enc, 40, (get_byte(credentials_enc, 40) + 1) % 256)
     where company_id = $1 and gateway = $2`,
    [companyId, gateway],
  );

describe('khoá cổng đã lưu không giải mã được (#63 B6)', () => {
  it('GET /payment/gateways → 200: cổng hỏng configured, credentials null; cổng khác vẫn che bình thường', async () => {
    const s = await shop('vietqr', 'momo');
    const list = () => request(testApp()).get('/api/v1/payment/gateways').set('Authorization', `Bearer ${s.ceo.token}`);
    const before = (await list()).body.find((g: { gateway: string }) => g.gateway === 'vietqr');
    await corrupt(s.companyId, 'vietqr');
    const res = await list();
    expect(res.status).toBe(200);
    const byGateway = Object.fromEntries(res.body.map((g: { gateway: string }) => [g.gateway, g]));
    expect(byGateway.vietqr).toMatchObject({ configured: true, version: 1, credentials: null, display: null });
    // URL SePay không cần giải mã, Admin vẫn cần để cấu hình lại.
    expect(before.webhookUrl).toMatch(/^https:\/\/api\.commerio\.test\/api\/v1\/payment\/webhooks\/sepay\//);
    expect(byGateway.vietqr.webhookUrl).toBe(before.webhookUrl);
    expect(byGateway.momo).toMatchObject({ configured: true, credentials: { secretKey: { last4: '9999' } } });
  });

  it('Admin lưu lại khoá theo version hiện có → 200, đọc lại thấy khoá đã che', async () => {
    const s = await shop('vietqr');
    await corrupt(s.companyId, 'vietqr');
    const save = await request(testApp())
      .put('/api/v1/payment/gateways/vietqr')
      .set('Authorization', `Bearer ${s.ceo.token}`)
      .send({ credentials: CREDENTIALS.vietqr, version: 1 });
    expect(save.status).toBe(200);
    const list = await request(testApp()).get('/api/v1/payment/gateways').set('Authorization', `Bearer ${s.ceo.token}`);
    const vietqr = list.body.find((g: { gateway: string }) => g.gateway === 'vietqr');
    expect(vietqr).toMatchObject({ version: 2, credentials: { sepayApiKey: { last4: '7788' } } });
  });

  it('PUT version cũ khi khoá hỏng → 409 version_conflict, current có credentials null (không 500)', async () => {
    const s = await shop('vietqr');
    await corrupt(s.companyId, 'vietqr');
    const save = await request(testApp())
      .put('/api/v1/payment/gateways/vietqr')
      .set('Authorization', `Bearer ${s.ceo.token}`)
      .send({ credentials: CREDENTIALS.vietqr, version: 0 });
    expect(save.status).toBe(409);
    expect(save.body.type).toBe('/problems/version_conflict');
    expect(save.body.current).toMatchObject({ configured: true, version: 1, credentials: null });
  });

  it('đơn có mã VietQR còn hạn: GET /payment/orders/:id và tạo lại mã → 200, bankTransfer đủ trừ tên chủ tài khoản rỗng', async () => {
    const s = await shop('vietqr');
    const o = await order(s);
    const created = await createLink(s.sale.token, o.orderId, 'vietqr');
    expect(created.status).toBe(201);
    await corrupt(s.companyId, 'vietqr');
    const res = await request(testApp())
      .get(`/api/v1/payment/orders/${o.orderId}`)
      .set('Authorization', `Bearer ${s.sale.token}`);
    expect(res.status).toBe(200);
    expect(res.body.activeLink.bankTransfer).toEqual({ ...created.body.bankTransfer, accountName: '' });
    expect(res.body.activeLink.bankTransfer.content).toBe(created.body.paymentCode);
    // Mã còn hạn được trả lại trước bước đọc khoá: 200 cùng mã, không 422.
    const again = await createLink(s.sale.token, o.orderId, 'vietqr');
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id: created.body.id, bankTransfer: { accountNo: '0123456789', accountName: '' } });
  });

  it('tạo mã bằng cổng có khoá hỏng → 422 gateway_not_configured kèm errors.gateway, không ghi mã', async () => {
    const s = await shop('vietqr');
    const o = await order(s);
    await corrupt(s.companyId, 'vietqr');
    const res = await createLink(s.sale.token, o.orderId, 'vietqr');
    expect(res.status).toBe(422);
    expect(res.body.type).toBe('/problems/gateway_not_configured');
    expect(res.body.errors.gateway).toBeTruthy();
    const links = await testPool().query('select count(*)::int n from finance.payment_links where order_id = $1', [o.orderId]);
    expect(links.rows[0].n).toBe(0);
  });
});
