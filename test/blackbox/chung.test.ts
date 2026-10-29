import { describe, expect, inject, it } from 'vitest';
import { ACCOUNTS, api, BASE_URL, call, PASSWORD } from './lib/client.ts';
import { expectProblem, ruleViolations } from './lib/contract.ts';

// Luật chung của mọi route (Documents/21 §1 C1–C5, §1.1 R1–R6): lỗi dạng Problem Details, xác thực, phân trang.

const tokens = inject('tokens');

describe('luật chung của API', () => {
  it('G-01: không gửi token, token rác đều nhận 401 unauthorized dạng Problem Details', async () => {
    expectProblem(await api().get('/purchasing/requests'), 401, 'unauthorized');
    expectProblem(await api('khong-phai-jwt').get('/purchasing/requests'), 401, 'unauthorized');
  });

  it('G-02: token chưa chọn công ty nhận 403 company_not_selected', async () => {
    const login = await call('POST', '/identity/login', { body: { email: ACCOUNTS.sale, password: PASSWORD } });
    expect(login.status).toBe(200);
    expectProblem(await api(login.body.accessToken).get('/catalog/products'), 403, 'company_not_selected');
  });

  it('G-03: đường dẫn không có nhận 404 not_found, kèm instance là đường dẫn gọi', async () => {
    const res = await api(tokens.ceo).get('/khong-co-module/abc');
    expectProblem(res, 404, 'not_found');
    expect(res.body.instance).toBe('/api/v1/khong-co-module/abc');
  });

  it('G-04: thân không phải JSON nhận 400 malformed_json', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/purchasing/suppliers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.ceo}`, 'Content-Type': 'application/json' },
      body: '{"name":',
    });
    expect([res.status, ((await res.json()) as { code: string }).code]).toEqual([400, 'malformed_json']);
  });

  it('G-05: dữ liệu sai nhận 422 validation_failed, lỗi theo ô trong errors', async () => {
    const res = await api(tokens.ceo).post('/purchasing/suppliers', {});
    expectProblem(res, 422, 'validation_failed');
    expect(Object.keys(res.body.errors)).toContain('name');
  });

  it('G-06: danh sách phân trang trả Page<T> (R6), mọi trường theo R2, R3, R5', async () => {
    const res = await api(tokens.ceo).get('/purchasing/requests?page=1&pageSize=3');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ items: expect.any(Array), total: expect.any(Number), page: 1, pageSize: 3 });
    expect(res.body.items.length).toBeLessThanOrEqual(3);
    expect(ruleViolations(res.body)).toEqual([]);
  });

  it('G-07: pageSize vượt giới hạn nhận 422 kèm errors.pageSize', async () => {
    const res = await api(tokens.ceo).get('/catalog/products?pageSize=1000');
    expectProblem(res, 422, 'validation_failed');
    expect(res.body.errors).toHaveProperty('pageSize');
  });
});
