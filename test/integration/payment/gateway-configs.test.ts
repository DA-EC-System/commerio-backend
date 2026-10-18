import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { addMember, createCompany } from '../helpers/company.ts';
import { testPool } from '../helpers/db.ts';
import { login, testApp } from '../helpers/http.ts';
import { lockCompany } from '../helpers/state.ts';

// Env đọc một lần lúc import (src/shared/config/env.ts): đặt khoá trước khi file test import code. Trong vi.hoisted chưa dùng được import.
vi.hoisted(() => {
  process.env.PAYMENT_CREDENTIALS_KEY = Buffer.alloc(32, 7).toString('base64');
  process.env.PUBLIC_API_URL = 'https://api.commerio.test';
});

// Cấu hình khoá cổng (commerio-backend#23 PR1, UC-PF-11; Documents/21 §12.3, §12.8, T4, T11, T12).
const API = '/api/v1/payment/gateways';

type Method = 'get' | 'put';
function call(method: Method, path: string, token?: string, body?: object) {
  const req = request(testApp())[method](API + path);
  if (token) req.set('Authorization', `Bearer ${token}`);
  return body ? req.send(body) : req;
}

const MOMO = { partnerCode: 'MOMO', accessKey: 'ACCESSKEY-0001', secretKey: 'SECRETKEY-ABCDEF-9999' };
const VIETQR = { bankBin: '970422', accountNo: '0123456789', accountName: 'CONG TY THU', sepayApiKey: 'SEPAY-KEY-55667788' };

async function configRow(companyId: string, gateway: string) {
  const r = await testPool().query(
    'select id, credentials_enc, is_configured, webhook_receiver_key, version, updated_by from payment.gateway_configs where company_id = $1 and gateway = $2',
    [companyId, gateway],
  );
  return r.rows[0] as
    | { id: string; credentials_enc: Buffer; is_configured: boolean; webhook_receiver_key: string | null; version: number; updated_by: string }
    | undefined;
}

const auditOf = async (entityId: string) =>
  (
    await testPool().query(
      "select action, actor_id, before, after from audit.audit_logs where entity_type = 'payment.gateway_configs' and entity_id = $1 order by id",
      [entityId],
    )
  ).rows;

async function companyWithAdmin() {
  const company = await createCompany();
  const admin = await addMember(company.companyId, 'admin');
  return { ...company, admin };
}

async function saveMomo(token: string, version = 0, credentials: object = MOMO) {
  return call('put', '/momo', token, { credentials, version });
}

describe('GET /payment/gateways', () => {
  it('người quản lý khoá thấy đủ 4 cổng theo thứ tự, cổng chưa cấu hình có version 0 và không có khoá (AC-1)', async () => {
    const { admin } = await companyWithAdmin();
    const res = await call('get', '', admin.token);
    expect(res.status).toBe(200);
    expect(res.body.map((g: { gateway: string }) => g.gateway)).toEqual(['vnpay', 'momo', 'zalopay', 'vietqr']);
    for (const g of res.body) {
      expect(g).toEqual({
        gateway: g.gateway,
        configured: false,
        version: 0,
        updatedAt: null,
        updatedBy: null,
        credentials: null,
        display: null,
        webhookUrl: null,
      });
    }
  });

  it('Sale chỉ thấy tên cổng và cờ đã cấu hình (AC-2)', async () => {
    const { companyId, admin } = await companyWithAdmin();
    expect((await saveMomo(admin.token)).status).toBe(200);
    const sale = await addMember(companyId, 'sale');
    const res = await call('get', '', sale.token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { gateway: 'vnpay', configured: false },
      { gateway: 'momo', configured: true },
      { gateway: 'zalopay', configured: false },
      { gateway: 'vietqr', configured: false },
    ]);
  });

  it('thiếu token 401, chưa chọn công ty 403, Nhân viên kho 403, công ty khoá 403 (AC-9)', async () => {
    const { companyId, ceo } = await createCompany();
    expect((await call('get', '')).status).toBe(401);
    const { token } = await login(ceo.email);
    const noCompany = await call('get', '', token);
    expect(noCompany.status).toBe(403);
    expect(noCompany.body.type).toBe('/problems/company_not_selected');
    const kho = await addMember(companyId, 'warehouse');
    const forbidden = await call('get', '', kho.token);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.type).toBe('/problems/forbidden');
    await lockCompany(companyId);
    expect((await call('get', '', ceo.token)).body.type).toBe('/problems/company_locked');
  });
});

describe('PUT /payment/gateways/:gateway', () => {
  it('lưu khoá MoMo: trả bản đã che, đọc lại thấy như vậy, DB chỉ có bản mã (AC-3)', async () => {
    const { companyId, admin } = await companyWithAdmin();
    const res = await saveMomo(admin.token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      gateway: 'momo',
      configured: true,
      version: 1,
      updatedBy: { id: admin.accountId, name: 'Nhân Viên Thử' },
      credentials: { partnerCode: { last4: 'MOMO' }, accessKey: { last4: '0001' }, secretKey: { last4: '9999' } },
      display: null,
      webhookUrl: null,
    });
    expect(JSON.stringify(res.body)).not.toContain(MOMO.secretKey);

    const read = await call('get', '', admin.token);
    expect(read.body[1]).toEqual(res.body);

    const row = await configRow(companyId, 'momo');
    expect(row).toMatchObject({ is_configured: true, version: 1, updated_by: admin.accountId });
    for (const value of [MOMO.accessKey, MOMO.secretKey]) expect(row!.credentials_enc.includes(Buffer.from(value))).toBe(false);
  });

  it('lưu lại với đúng version thì tăng version; version cũ thì 409 kèm bản hiện tại đã che, DB không đổi (AC-4)', async () => {
    const { companyId, admin } = await companyWithAdmin();
    await saveMomo(admin.token);
    const updated = await saveMomo(admin.token, 1, { ...MOMO, secretKey: 'SECRETKEY-NEW-00001234' });
    expect(updated.status).toBe(200);
    expect(updated.body.version).toBe(2);
    expect(updated.body.credentials.secretKey).toEqual({ last4: '1234' });
    const before = await configRow(companyId, 'momo');

    const stale = await saveMomo(admin.token, 1, { ...MOMO, secretKey: 'SECRETKEY-STALE-5678' });
    expect(stale.status).toBe(409);
    expect(stale.body.type).toBe('/problems/version_conflict');
    expect(stale.body.current).toMatchObject({ gateway: 'momo', version: 2, credentials: { secretKey: { last4: '1234' } } });
    expect(JSON.stringify(stale.body)).not.toContain('SECRETKEY');
    const after = await configRow(companyId, 'momo');
    expect(after!.version).toBe(2);
    expect(after!.credentials_enc.equals(before!.credentials_enc)).toBe(true);
  });

  it('version 0 khi cổng đã cấu hình thì 409; hai lần tạo song song chỉ một lần thành công', async () => {
    const { companyId, admin } = await companyWithAdmin();
    const [a, b] = await Promise.all([saveMomo(admin.token), saveMomo(admin.token)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await configRow(companyId, 'momo'))!.version).toBe(1);
    expect((await saveMomo(admin.token, 0)).status).toBe(409);
  });

  it('thiếu ô, ô rỗng, khoá bí mật quá ngắn, sai kiểu → 422 theo ô (AC-5)', async () => {
    const { admin } = await companyWithAdmin();
    const res = await saveMomo(admin.token, 0, { partnerCode: '  ', secretKey: 'ngan' });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.errors).sort()).toEqual(['credentials.accessKey', 'credentials.partnerCode', 'credentials.secretKey']);
    expect(JSON.stringify(res.body)).not.toContain('ngan"');

    const vietqr = await call('put', '/vietqr', admin.token, {
      credentials: { ...VIETQR, bankBin: '97042', accountNo: '12ab' },
      version: 0,
    });
    expect(vietqr.status).toBe(422);
    expect(Object.keys(vietqr.body.errors).sort()).toEqual(['credentials.accountNo', 'credentials.bankBin']);

    const noVersion = await call('put', '/momo', admin.token, { credentials: MOMO });
    expect(noVersion.status).toBe(422);
    expect(noVersion.body.errors).toHaveProperty('version');
  });

  it('PUT: thiếu token 401, chưa chọn công ty 403, Nhân viên kho 403 (AC-9)', async () => {
    const { companyId, ceo } = await createCompany();
    expect((await saveMomo('')).status).toBe(401);
    const { token } = await login(ceo.email);
    expect((await saveMomo(token)).body.type).toBe('/problems/company_not_selected');
    const kho = await addMember(companyId, 'warehouse');
    const res = await saveMomo(kho.token);
    expect(res.status).toBe(403);
    expect(res.body.type).toBe('/problems/forbidden');
    expect(await configRow(companyId, 'momo')).toBeUndefined();
  });

  it('version âm, version không nguyên, ô là số thay vì chuỗi → 422 theo ô (AC-5)', async () => {
    const { admin } = await companyWithAdmin();
    const negative = await saveMomo(admin.token, -1);
    expect(negative.status).toBe(422);
    expect(negative.body.errors).toHaveProperty('version');
    expect((await saveMomo(admin.token, 1.5)).body.errors).toHaveProperty('version');
    const wrongType = await saveMomo(admin.token, 0, { ...MOMO, accessKey: 12345678 });
    expect(wrongType.status).toBe(422);
    expect(Object.keys(wrongType.body.errors)).toEqual(['credentials.accessKey']);
  });

  it('cổng lạ → 404; Sale → 403 trước khi kiểm body (AC-5, AC-9)', async () => {
    const { companyId, admin } = await companyWithAdmin();
    const unknown = await call('put', '/paypal', admin.token, { credentials: {}, version: 0 });
    expect(unknown.status).toBe(404);
    const sale = await addMember(companyId, 'sale');
    const res = await call('put', '/momo', sale.token, { credentials: {} });
    expect(res.status).toBe(403);
    expect(res.body.type).toBe('/problems/forbidden');
  });

  it('ghi nhật ký thao tác không có giá trị khoá (AC-6)', async () => {
    const { companyId, admin } = await companyWithAdmin();
    await saveMomo(admin.token);
    await saveMomo(admin.token, 1);
    const row = await configRow(companyId, 'momo');
    const logs = await auditOf(row!.id);
    expect(logs).toEqual([
      { action: 'create', actor_id: admin.accountId, before: null, after: { gateway: 'momo', configured: true, version: 1 } },
      {
        action: 'update',
        actor_id: admin.accountId,
        before: { gateway: 'momo', configured: true, version: 1 },
        after: { gateway: 'momo', configured: true, version: 2 },
      },
    ]);
  });

  it('VietQR: sinh URL webhook SePay riêng, giữ nguyên khi lưu lại, trả thông tin hiển thị (AC-7)', async () => {
    const { companyId, admin } = await companyWithAdmin();
    const first = await call('put', '/vietqr', admin.token, { credentials: VIETQR, version: 0 });
    expect(first.status).toBe(200);
    const key = (await configRow(companyId, 'vietqr'))!.webhook_receiver_key!;
    expect(key).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(first.body).toMatchObject({
      display: { bankBin: '970422', bankName: 'MB Bank', accountName: 'CONG TY THU' },
      webhookUrl: `https://api.commerio.test/api/v1/payment/webhooks/sepay/${key}`,
    });

    const again = await call('put', '/vietqr', admin.token, { credentials: { ...VIETQR, accountNo: '9988776655' }, version: 1 });
    expect(again.status).toBe(200);
    expect((await configRow(companyId, 'vietqr'))!.webhook_receiver_key).toBe(key);
    expect(again.body.webhookUrl).toBe(first.body.webhookUrl);
  });

  it('công ty khác không thấy và không sửa được cấu hình của công ty này (AC-8)', async () => {
    const a = await companyWithAdmin();
    const b = await companyWithAdmin();
    await saveMomo(a.admin.token);
    const listB = await call('get', '', b.admin.token);
    expect(listB.body[1]).toMatchObject({ gateway: 'momo', configured: false, version: 0 });
    const saveB = await saveMomo(b.admin.token, 0, { ...MOMO, secretKey: 'SECRETKEY-CUA-B-0000' });
    expect(saveB.status).toBe(200);
    expect((await call('get', '', a.admin.token)).body[1].credentials.secretKey).toEqual({ last4: '9999' });
    expect((await configRow(a.companyId, 'momo'))!.version).toBe(1);
  });
});
