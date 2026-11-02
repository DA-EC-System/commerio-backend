import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';

// Nhật ký thao tác của công ty (UC-PI-07, Documents/21 M1, M5, #152).

const get = (token: string, path: string) =>
  request(testApp()).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);

/** Một thao tác thật có ghi nhật ký: bật phân hệ inbox. */
async function toggleInbox(token: string) {
  const res = await request(testApp())
    .put('/api/v1/platform/modules/inbox')
    .set('Authorization', `Bearer ${token}`)
    .send({ enabled: true });
  expect(res.status).toBe(200);
}

describe('GET /audit/logs', () => {
  it('CEO thấy nhật ký của công ty mình, mới nhất trước, kèm người làm và tên đối tượng', async () => {
    const { ceo } = await createCompany({ optionalModules: [] });
    await toggleInbox(ceo.token);
    const res = await get(ceo.token, '/audit/logs');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    expect(res.body.items[0]).toMatchObject({
      id: expect.any(String),
      action: 'update',
      entityType: 'core.company_modules',
      entityId: null,
      entityLabel: 'inbox',
      actor: { email: ceo.email },
      createdAt: expect.any(String),
    });
  });

  it('không thấy nhật ký của công ty khác, kể cả dòng cấp nền tảng (đăng ký công ty)', async () => {
    const a = await createCompany({ optionalModules: [] });
    const b = await createCompany({ optionalModules: [] });
    await toggleInbox(b.ceo.token);
    expect((await get(a.ceo.token, '/audit/logs')).body.total).toBe(0);
  });

  it('lọc theo action, entityType, actorId và ngày giờ Việt Nam', async () => {
    const { companyId, ceo } = await createCompany({ optionalModules: [] });
    await toggleInbox(ceo.token);
    const [{ id: actorId }] = (
      await testPool().query('select actor_id as id from core.audit_logs where company_id = $1', [companyId])
    ).rows;
    // Đẩy dòng về 23:30 ngày 01/10/2026 giờ VN (16:30 UTC) để kiểm cận ngày theo giờ VN.
    await testPool().query("update core.audit_logs set created_at = '2026-10-01T16:30:00Z' where company_id = $1", [
      companyId,
    ]);
    const total = async (query: string) => (await get(ceo.token, `/audit/logs?${query}`)).body.total;
    expect(await total('action=update')).toBe(1);
    expect(await total('action=create')).toBe(0);
    expect(await total('entityType=core.company_modules')).toBe(1);
    expect(await total(`actorId=${actorId}`)).toBe(1);
    expect(await total('from=2026-10-01&to=2026-10-01')).toBe(1);
    expect(await total('from=2026-10-02')).toBe(0);
    expect((await get(ceo.token, '/audit/logs?pageSize=500')).status).toBe(422);
  });

  it('Admin xem được; Sale nhận 403 forbidden', async () => {
    const { companyId } = await createCompany();
    expect((await get((await addMember(companyId, 'admin')).token, '/audit/logs')).status).toBe(200);
    expect((await get((await addMember(companyId, 'sale')).token, '/audit/logs')).body.type).toBe('/problems/forbidden');
  });
});

describe('GET /audit/logs/:id', () => {
  it('trả thêm before, after; id của công ty khác hay không phải số nhận 404', async () => {
    const a = await createCompany({ optionalModules: [] });
    const b = await createCompany({ optionalModules: [] });
    await toggleInbox(a.ceo.token);
    const id = (await get(a.ceo.token, '/audit/logs')).body.items[0].id;

    const res = await get(a.ceo.token, `/audit/logs/${id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id,
      before: { module: 'inbox', enabled: false },
      after: { module: 'inbox', enabled: true },
    });
    expect((await get(b.ceo.token, `/audit/logs/${id}`)).body.type).toBe('/problems/not_found');
    expect((await get(a.ceo.token, '/audit/logs/abc')).status).toBe(404);
  });
});
