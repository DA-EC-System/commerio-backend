// Gỡ mã số thuế và nhập lại (#459, Documents/21 mục 2.1, V18).
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '#src/modules/core/identity/service/passwords.ts';
import { handleTaxCodeReleasedMail, renderTaxCodeReleasedMail } from '#src/modules/core/platform/service/tax-code-release.ts';
import { type MailTransport, setMailTransport } from '#src/shared/mail/index.ts';
import { registerCompany, uniqueEmail, uniqueTaxCode } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { login, PASSWORD, testApp } from '../../helpers/http.ts';

const db = testPool();
const api = (token: string) => ({
  get: (path: string) => request(testApp()).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`),
  post: (path: string, body: object) =>
    request(testApp()).post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body),
  put: (path: string, body: object) =>
    request(testApp()).put(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body),
});

type SentMail = Parameters<MailTransport['sendMail']>[0];
afterEach(() => setMailTransport(null));

let adminToken = '';
beforeAll(async () => {
  const email = uniqueEmail('qtnt');
  await db.query(
    `insert into core.accounts (email, full_name, password_hash, is_platform_admin) values ($1, 'Quản Trị', $2, true)`,
    [email, await hashPassword(PASSWORD)],
  );
  adminToken = (await login(email)).token;
});

async function company() {
  const taxCode = uniqueTaxCode();
  const name = `Công ty giữ mã ${randomUUID().slice(0, 8)}`;
  const { companyId, accessToken, email } = await registerCompany(uniqueEmail(), { company: { name, taxCode } });
  return { companyId, ceoToken: accessToken, ceoEmail: email, taxCode, name };
}
const versionOf = async (companyId: string) =>
  (await db.query<{ version: number }>('select version from core.companies where id = $1', [companyId])).rows[0]!.version;
const release = (companyId: string, version: number, reason = 'Mã của doanh nghiệp khác, có giấy đăng ký') =>
  api(adminToken).post(`/platform/companies/${companyId}/release-tax-code`, { reason, version });

describe('POST /platform/companies/:id/release-tax-code', () => {
  it('200 taxCode null; nhật ký nền tảng company.tax_code_released kèm lý do; xếp việc gửi thư', async () => {
    const c = await company();
    const res = await release(c.companyId, await versionOf(c.companyId));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: c.companyId, taxCode: null });

    const logs = await api(adminToken).get(`/platform/audit-logs?action=company.tax_code_released&search=${encodeURIComponent(c.name)}`);
    expect(logs.body.items).toEqual([
      expect.objectContaining({ action: 'company.tax_code_released', targetCompanyId: c.companyId, reason: expect.stringContaining('doanh nghiệp khác') }),
    ]);
    // Dòng gỡ mã không bị xếp vào mở khoá
    const unlocked = await api(adminToken).get(`/platform/audit-logs?action=company.unlocked&search=${encodeURIComponent(c.name)}`);
    expect(unlocked.body.items).toEqual([]);
    const audit = await db.query(
      "select before, after from core.audit_logs where entity_id = $1 and operation = 'release_tax_code'",
      [c.companyId],
    );
    expect(audit.rows[0]).toMatchObject({ before: { taxCode: c.taxCode }, after: { taxCode: null } });
    const jobs = await db.query("select data from pgboss.job where name = 'platform.tax_code_released_mail' and data->>'companyId' = $1", [c.companyId]);
    expect(jobs.rows[0]?.data).toMatchObject({ taxCode: c.taxCode });
  });

  it('đã gỡ: 409 invalid_transition; lệch version: 409 version_conflict kèm current; id lạ: 404; doanh nghiệp đúng đăng ký được bằng mã này', async () => {
    const c = await company();
    expect((await release(c.companyId, (await versionOf(c.companyId)) + 5)).body.code).toBe('version_conflict');
    expect((await release(c.companyId, await versionOf(c.companyId))).status).toBe(200);
    const again = await release(c.companyId, await versionOf(c.companyId));
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('invalid_transition');
    expect((await release(randomUUID(), 1)).status).toBe(404);
    await registerCompany(uniqueEmail(), { company: { name: 'Doanh nghiệp đúng', taxCode: c.taxCode } });
  });

  it('không phải quản trị nền tảng: 403; thiếu lý do: 422', async () => {
    const c = await company();
    const res = await api(c.ceoToken).post(`/platform/companies/${c.companyId}/release-tax-code`, { reason: 'x', version: 1 });
    expect(res.status).toBe(403);
    const bad = await api(adminToken).post(`/platform/companies/${c.companyId}/release-tax-code`, { reason: ' ', version: 1 });
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toHaveProperty('reason');
  });
});

describe('thư báo CEO', () => {
  it('gửi tới CEO, có tên công ty, mã đã gỡ, lý do (một dòng)', async () => {
    const c = await company();
    const sent: SentMail[] = [];
    setMailTransport({ sendMail: async (m) => (sent.push(m), {}) });
    await handleTaxCodeReleasedMail({ companyId: c.companyId, taxCode: c.taxCode, reason: 'Mã của\ndoanh nghiệp khác' });
    expect(sent).toHaveLength(1);
    expect(String(sent[0]!.to)).toBe(c.ceoEmail);
    expect(sent[0]!.text).toContain(c.taxCode);
    expect(sent[0]!.text).toContain('Lý do: Mã của doanh nghiệp khác');
  });

  it('html thoát ký tự của tên và lý do', () => {
    const mail = renderTaxCodeReleasedMail({ companyName: '<b>A</b>', taxCode: '0123456789', reason: '<script>', profileUrl: null });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;b&gt;A&lt;/b&gt;');
  });
});

describe('PUT /platform/company: nhập mã số thuế khi đang trống', () => {
  it('đang có mã: 422 errors.taxCode; sau khi gỡ: nhập mã khác được (chuẩn hoá), ghi nhật ký công ty', async () => {
    const c = await company();
    const has = await api(c.ceoToken).put('/platform/company', { taxCode: uniqueTaxCode(), version: await versionOf(c.companyId) });
    expect(has.status).toBe(422);
    expect(has.body.errors).toHaveProperty('taxCode');

    await release(c.companyId, await versionOf(c.companyId));
    const fresh = uniqueTaxCode();
    const res = await api(c.ceoToken).put('/platform/company', {
      taxCode: `${fresh.slice(0, 4)} ${fresh.slice(4)}`,
      version: await versionOf(c.companyId),
    });
    expect(res.status).toBe(200);
    expect(res.body.taxCode).toBe(fresh);
    const audit = await db.query(
      "select before, after from core.audit_logs where company_id = $1 and entity_type = 'core.companies' and action = 'update'",
      [c.companyId],
    );
    expect(audit.rows.at(-1)).toMatchObject({ before: { taxCode: null }, after: { taxCode: fresh } });
  });

  it('mã vừa bị gỡ khỏi chính công ty: 422; mã của công ty khác: 409 tax_code_taken; sai định dạng: 422', async () => {
    const c = await company();
    const other = await company();
    await release(c.companyId, await versionOf(c.companyId));
    const own = await api(c.ceoToken).put('/platform/company', { taxCode: c.taxCode, version: await versionOf(c.companyId) });
    expect(own.status).toBe(422);
    expect(own.body.errors.taxCode).toContain('đã bị quản trị Commerio gỡ');
    const taken = await api(c.ceoToken).put('/platform/company', { taxCode: other.taxCode, version: await versionOf(c.companyId) });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('tax_code_taken');
    const bad = await api(c.ceoToken).put('/platform/company', { taxCode: '123', version: await versionOf(c.companyId) });
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toHaveProperty('taxCode');
  });
});
