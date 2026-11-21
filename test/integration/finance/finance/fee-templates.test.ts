// Biểu phí mẫu của nền tảng (Documents/21 §21.6): công ty đọc, quản trị nền tảng soạn, sửa; cấu hình phí dựng từ mẫu ghi
// `sourceTemplate` và được nhắc khi mẫu đổi.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '#src/modules/core/identity/service/passwords.ts';
import { createCompany, uniqueEmail } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { login, PASSWORD, testApp } from '../../helpers/http.ts';

const as = (token: string) => ({
  get: (path: string) => request(testApp()).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`),
  post: (path: string, body: object) => request(testApp()).post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body),
  put: (path: string, body: object) => request(testApp()).put(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body),
});
const problem = (res: { status: number; body: { type?: string } }, status: number, code: string) => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(res.body.type).toBe(`/problems/${code}`);
};

const PAYLOAD = { fixedPct: 5, transactionPct: 4, servicePct: 0, optionalPct: 0, returnFee: 0 };
/** Phần sửa được của mẫu (PUT không nhận `platform`, `shopType`). */
const editable = () => ({
  shopTypeLabel: 'Shop thử',
  payload: PAYLOAD,
  sources: [{ title: 'Trang phí', url: 'https://sellercenter.lazada.vn/helpcenter', updatedAt: '2026-05-27' }],
  effectiveFrom: '2026-07-02',
  note: 'Mẫu thử',
});
const template = (shopType: string) => ({
  platform: 'lazada',
  shopType,
  shopTypeLabel: 'Shop thử',
  payload: PAYLOAD,
  sources: [{ title: 'Trang phí', url: 'https://sellercenter.lazada.vn/helpcenter', updatedAt: '2026-05-27' }],
  effectiveFrom: '2026-07-02',
  note: 'Mẫu thử',
});

let admin: string;
let ceo: string;
beforeAll(async () => {
  const email = uniqueEmail('qtnt');
  await testPool().query(
    `insert into core.accounts (email, full_name, password_hash, is_platform_admin) values ($1, 'Quản Trị Nền Tảng', $2, true)`,
    [email, await hashPassword(PASSWORD)],
  );
  admin = (await login(email)).token;
  ceo = (await createCompany({ optionalModules: [] })).ceo.token;
});

describe('biểu phí mẫu (Documents/21 §21.6)', () => {
  it('công ty đọc mẫu TikTok do migration ghi (14% shop thường, 16% Mall); lọc theo sàn', async () => {
    const res = await as(ceo).get('/finance/fee-templates?platform=tiktok');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const byType = Object.fromEntries(res.body.items.map((t: { shopType: string; payload: { fixedPct: number } }) => [t.shopType, t.payload.fixedPct]));
    expect(byType).toMatchObject({ standard: 14, mall: 16 });
    expect(res.body.items.every((t: { platform: string; sources: unknown[] }) => t.platform === 'tiktok' && t.sources.length > 0)).toBe(true);
  });

  it('quản trị nền tảng thêm, sửa mẫu; công ty không gọi được route nền tảng; sàn lạ, trùng, sai version, sai payload báo đúng mã', async () => {
    problem(await as(ceo).post('/platform/fee-templates', template('x')), 403, 'forbidden');

    const shopType = `t_${randomUUID().slice(0, 8)}`;
    const created = await as(admin).post('/platform/fee-templates', template(shopType));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ platform: 'lazada', shopType, version: 1, payload: PAYLOAD });

    problem(await as(admin).post('/platform/fee-templates', template(shopType)), 409, 'template_exists');
    const unknown = await as(admin).post('/platform/fee-templates', { ...template(`u_${randomUUID().slice(0, 6)}`), platform: 'khong-co' });
    problem(unknown, 422, 'validation_failed');
    expect(unknown.body.errors).toHaveProperty('platform');
    const badPayload = await as(admin).post('/platform/fee-templates', { ...template(`p_${randomUUID().slice(0, 6)}`), payload: { ...PAYLOAD, fixedPct: 101 } });
    problem(badPayload, 422, 'validation_failed');
    expect(badPayload.body.errors).toHaveProperty(['payload.fixedPct']);

    const updated = await as(admin).put(`/platform/fee-templates/${created.body.id}`, { ...editable(), payload: { ...PAYLOAD, fixedPct: 6 }, version: 1 });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body).toMatchObject({ version: 2, payload: { fixedPct: 6 } });
    const stale = await as(admin).put(`/platform/fee-templates/${created.body.id}`, { ...editable(), version: 1 });
    problem(stale, 409, 'version_conflict');
    expect(stale.body.current).toMatchObject({ version: 2 });

    const audit = await testPool().query("select action from core.audit_logs where entity_type = 'finance.fee_templates' and entity_id = $1 order by created_at", [created.body.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['create', 'update']);
  });

  it('cấu hình phí dựng từ mẫu ghi sourceTemplate; mẫu đổi sau khi bản đã áp dụng thì templateOutdated; templateId với loại khác 422', async () => {
    const shopType = `c_${randomUUID().slice(0, 8)}`;
    const t = (await as(admin).post('/platform/fee-templates', template(shopType))).body;
    const shopId = randomUUID();
    const config = await as(ceo).post('/finance/configs', { kind: 'fee', shopId, payload: PAYLOAD, effectiveFrom: '2026-12-01', templateId: t.id });
    expect(config.status, JSON.stringify(config.body)).toBe(201);
    expect(config.body).toMatchObject({ sourceTemplate: { id: t.id, platform: 'lazada', shopType, version: 1 }, templateOutdated: false });

    const wrongKind = await as(ceo).post('/finance/configs', { kind: 'min_margin', payload: { pct: 10 }, effectiveFrom: '2026-12-01', templateId: t.id });
    problem(wrongKind, 422, 'validation_failed');
    expect(wrongKind.body.errors).toHaveProperty('templateId');
    const missing = await as(ceo).post('/finance/configs', { kind: 'fee', shopId: randomUUID(), payload: PAYLOAD, effectiveFrom: '2026-12-01', templateId: randomUUID() });
    expect(missing.body.errors).toHaveProperty('templateId');

    // Bản đã áp dụng (đặt thẳng, bỏ qua luồng duyệt) rồi mẫu đổi: nhắc xem lại.
    await testPool().query("update finance.config_versions set status = 'active', approved_by = gen_random_uuid(), approved_at = now() where id = $1", [config.body.id]);
    expect((await as(admin).put(`/platform/fee-templates/${t.id}`, { ...editable(), version: 1 })).status).toBe(200);
    const after = await as(ceo).get(`/finance/configs/${config.body.id}`);
    expect(after.body).toMatchObject({ sourceTemplate: { id: t.id, version: 1 }, templateOutdated: true });
  });
});
