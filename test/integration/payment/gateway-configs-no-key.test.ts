import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createCompany } from '../helpers/company.ts';
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
});
