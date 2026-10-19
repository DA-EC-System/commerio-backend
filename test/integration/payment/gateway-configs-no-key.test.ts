import { randomBytes } from 'node:crypto';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildVietQr } from '#src/modules/payment/domain/vietqr.ts';
import { newPaymentCode } from '#src/modules/payment/domain/payment-code.ts';
import { encryptCredentials } from '#src/modules/payment/service/credentials-cipher.ts';
import { createVariant } from '../helpers/catalog.ts';
import { createCompany } from '../helpers/company.ts';
import { createOrder } from '../helpers/sales.ts';
import { testPool } from '../helpers/db.ts';
import { testApp } from '../helpers/http.ts';

// Máy chủ chưa đặt PAYMENT_CREDENTIALS_KEY (vitest.config.ts không đặt): không lưu được khoá, nhưng vẫn xem được danh sách
// cổng chưa cấu hình (commerio-backend#23 AC-10).
const API = '/api/v1/payment/gateways';

describe('cấu hình cổng khi thiếu PAYMENT_CREDENTIALS_KEY', () => {
  it('GET vẫn trả 4 cổng chưa cấu hình; PUT báo 500 payment_credentials_key_missing và không ghi gì', async () => {
    const { companyId, ceo } = await createCompany();
    const list = await request(testApp()).get(API).set('Authorization', `Bearer ${ceo.token}`);
    expect(list.status).toBe(200);
    expect(list.body.map((g: { configured: boolean }) => g.configured)).toEqual([false, false, false, false]);

    const save = await request(testApp())
      .put(`${API}/momo`)
      .set('Authorization', `Bearer ${ceo.token}`)
      .send({ credentials: { partnerCode: 'MOMO', accessKey: 'ACCESSKEY-0001', secretKey: 'SECRETKEY-ABCDEF-9999' }, version: 0 });
    expect(save.status).toBe(500);
    expect(save.body.type).toBe('/problems/payment_credentials_key_missing');
    const rows = await testPool().query('select count(*)::int n from payment.gateway_configs where company_id = $1', [companyId]);
    expect(rows.rows[0].n).toBe(0);
  });

  it('đơn có mã VietQR (khoá lưu từ máy có khoá chủ) → GET /payment/orders/:id 200, tên chủ tài khoản rỗng (#63 B6)', async () => {
    const { companyId, ceo } = await createCompany();
    const { variantId } = await createVariant(companyId);
    const o = await createOrder(companyId, { lines: [{ variantId, quantity: 1, unitPrice: 150000 }] });
    // Dựng tay như dữ liệu một máy khác (có khoá chủ) đã ghi: máy này không đặt khoá nên không lưu qua API được.
    const credentials = { bankBin: '970422', accountNo: '0123456789', accountName: 'CONG TY THU', sepayApiKey: 'SEPAY-KEY-55667788' };
    await testPool().query(
      `insert into payment.gateway_configs (company_id, gateway, credentials_enc, is_configured, webhook_receiver_key)
       values ($1, 'vietqr', $2, true, $3)`,
      [companyId, encryptCredentials(credentials, `${companyId}:vietqr`, randomBytes(32)), randomBytes(24).toString('base64url')],
    );
    const paymentCode = newPaymentCode();
    const qr = buildVietQr({ bankBin: '970422', accountNo: '0123456789', amount: new Decimal(150000), content: paymentCode });
    await testPool().query(
      `insert into payment.payment_links (company_id, order_id, gateway, payment_code, amount, qr_content, expires_at)
       values ($1, $2, 'vietqr', $3, 150000, $4, now() + interval '15 minutes')`,
      [companyId, o.orderId, paymentCode, qr],
    );
    const res = await request(testApp()).get(`/api/v1/payment/orders/${o.orderId}`).set('Authorization', `Bearer ${ceo.token}`);
    expect(res.status).toBe(200);
    expect(res.body.activeLink.bankTransfer).toMatchObject({ accountNo: '0123456789', accountName: '', content: paymentCode });
  });
});
