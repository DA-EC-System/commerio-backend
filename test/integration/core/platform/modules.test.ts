import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { raceBehindLock } from '../../helpers/locks.ts';

// Phân hệ tuỳ chọn của công ty (UC-PI-02, Documents/21 M1–M4, #152).

const as = (token: string) => ({
  get: (path: string) => request(testApp()).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`),
  put: (path: string, body: object) =>
    request(testApp()).put(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body),
  post: (path: string, body: object) =>
    request(testApp()).post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body),
});

const moduleOf = (body: { code: string; [field: string]: unknown }[], code: string) => body.find((m) => m.code === code)!;

describe('GET /platform/modules', () => {
  it('CEO thấy đúng năm phân hệ tuỳ chọn, phân hệ chọn lúc đăng ký đang bật kèm người bật', async () => {
    const { ceo } = await createCompany({ optionalModules: ['purchasing'] });
    const res = await as(ceo.token).get('/platform/modules');
    expect(res.status).toBe(200);
    expect(res.body.map((m: { code: string }) => m.code)).toEqual(['purchasing', 'channel', 'inbox', 'assistant', 'report']);
    const purchasing = moduleOf(res.body, 'purchasing');
    expect(purchasing).toMatchObject({ enabled: true, hasData: false, aiConsentAt: null, aiConsentBy: null });
    expect(purchasing.enabledBy).toMatchObject({ email: ceo.email });
    expect(moduleOf(res.body, 'channel')).toMatchObject({ enabled: false, enabledAt: null, enabledBy: null });
  });

  it('Admin thiếu platform.module.manage nhận 403 forbidden; không token nhận 401', async () => {
    const { companyId } = await createCompany();
    const admin = await addMember(companyId, 'admin');
    expect((await as(admin.token).get('/platform/modules')).body.type).toBe('/problems/forbidden');
    expect((await request(testApp()).get('/api/v1/platform/modules')).status).toBe(401);
  });
});

describe('PUT /platform/modules/:code', () => {
  it('bật channel: trả phân hệ và danh sách đang bật, đọc lại thấy bật, có nhật ký cùng giao dịch', async () => {
    const { companyId, ceo } = await createCompany({ optionalModules: [] });
    const res = await as(ceo.token).put('/platform/modules/channel', { enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.module).toMatchObject({ code: 'channel', enabled: true, hasData: false });
    expect(res.body.enabledModules).toContain('channel');
    expect(res.body.enabledModules).toContain('catalog');

    expect(moduleOf((await as(ceo.token).get('/platform/modules')).body, 'channel').enabled).toBe(true);
    const log = await testPool().query(
      `select action, before, after from core.audit_logs
       where company_id = $1 and entity_type = 'core.company_modules' order by id`,
      [companyId],
    );
    expect(log.rows).toEqual([
      { action: 'update', before: { module: 'channel', enabled: false }, after: { module: 'channel', enabled: true } },
    ]);
  });

  it('chuyển về trạng thái đang có: 409 module_state_changed kèm current', async () => {
    const { ceo } = await createCompany({ optionalModules: ['report'] });
    const res = await as(ceo.token).put('/platform/modules/report', { enabled: true });
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/module_state_changed');
    expect(res.body.current).toMatchObject({ code: 'report', enabled: true });
  });

  it('bật assistant phải đồng ý gửi dữ liệu tới OpenAI', async () => {
    const { ceo } = await createCompany({ optionalModules: [] });
    const missing = await as(ceo.token).put('/platform/modules/assistant', { enabled: true });
    expect(missing.status).toBe(422);
    expect(missing.body.type).toBe('/problems/ai_consent_required');

    const res = await as(ceo.token).put('/platform/modules/assistant', { enabled: true, aiConsent: true });
    expect(res.status).toBe(200);
    expect(res.body.module.aiConsentAt).toEqual(expect.any(String));
    expect(res.body.module.aiConsentBy).toMatchObject({ email: ceo.email });
  });

  it('phân hệ đã có dữ liệu không tắt được: 409 module_has_data kèm current', async () => {
    const { ceo } = await createCompany({ optionalModules: ['purchasing'] });
    const supplier = await as(ceo.token).post('/purchasing/suppliers', { name: `NCC ${randomUUID()}` });
    expect(supplier.status).toBe(201);
    expect(moduleOf((await as(ceo.token).get('/platform/modules')).body, 'purchasing').hasData).toBe(true);

    const res = await as(ceo.token).put('/platform/modules/purchasing', { enabled: false });
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/module_has_data');
    expect(res.body.current).toMatchObject({ code: 'purchasing', enabled: true, hasData: true });
  });

  it('tắt phân hệ chưa có dữ liệu: request kế tiếp vào API của phân hệ đó nhận 403 module_disabled', async () => {
    const { ceo } = await createCompany({ optionalModules: ['purchasing'] });
    expect((await as(ceo.token).get('/purchasing/suppliers')).status).toBe(200);
    const res = await as(ceo.token).put('/platform/modules/purchasing', { enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.enabledModules).not.toContain('purchasing');
    expect((await as(ceo.token).get('/purchasing/suppliers')).body.type).toBe('/problems/module_disabled');
  });

  it('report luôn tắt được (bảng dựng lại từ dữ liệu gốc)', async () => {
    const { ceo } = await createCompany({ optionalModules: ['report'] });
    expect((await as(ceo.token).put('/platform/modules/report', { enabled: false })).status).toBe(200);
  });

  it('phân hệ lõi hay mã lạ: 404 module_not_found; enabled sai kiểu: 422', async () => {
    const { ceo } = await createCompany();
    expect((await as(ceo.token).put('/platform/modules/catalog', { enabled: false })).body.type).toBe(
      '/problems/module_not_found',
    );
    expect((await as(ceo.token).put('/platform/modules/khong-co', { enabled: true })).status).toBe(404);
    expect((await as(ceo.token).put('/platform/modules/channel', { enabled: 'yes' })).status).toBe(422);
  });

  it('Admin không bật được phân hệ: 403 forbidden trước khi kiểm body', async () => {
    const { companyId } = await createCompany();
    const admin = await addMember(companyId, 'admin');
    expect((await as(admin.token).put('/platform/modules/channel', {})).body.type).toBe('/problems/forbidden');
  });

  it('hai lần bật cùng lúc: một 200, một 409 module_state_changed, một dòng nhật ký', async () => {
    const { companyId, ceo } = await createCompany({ optionalModules: [] });
    // Phân hệ chưa từng bật thì chưa có dòng để khoá: dựng dòng đang tắt rồi khoá nó.
    await testPool().query(
      "insert into core.company_modules (company_id, module_code, enabled) values ($1, 'inbox', false)",
      [companyId],
    );
    const results = await raceBehindLock(
      (holder) =>
        holder.query("select 1 from core.company_modules where company_id = $1 and module_code = 'inbox' for update", [
          companyId,
        ]),
      2,
      () =>
        Promise.all([
          as(ceo.token).put('/platform/modules/inbox', { enabled: true }),
          as(ceo.token).put('/platform/modules/inbox', { enabled: true }),
        ]),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const log = await testPool().query(
      "select count(*)::int as n from core.audit_logs where company_id = $1 and entity_type = 'core.company_modules'",
      [companyId],
    );
    expect(log.rows[0].n).toBe(1);
  });
});
