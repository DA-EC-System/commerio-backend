import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BUILTIN_ROLES } from '#src/modules/core/access/domain/catalog.ts';
import { setMailTransport } from '#src/shared/mail/index.ts';
import { addMember, createCompany, uniqueEmail } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { PASSWORD, testApp } from '../../helpers/http.ts';
import { accountIdOf, claimLink, joinApi, newLink, pendingInvitation } from './helpers.ts';

// Huỷ link mời chưa nộp và tab "Link đã tạo" (Documents/21 mục 3.1; Documents/27 US-CT-05 AC 4–6, US-CT-06 AC 8).
const app = testApp();
const db = testPool();
const join = joinApi(app);
const SALE = BUILTIN_ROLES.sale.id;

afterEach(() => setMailTransport(null));

const as = (token: string) => ({
  list: (status?: string) =>
    request(app)
      .get('/api/v1/identity/invitations')
      .query(status === undefined ? {} : { status })
      .set('Authorization', `Bearer ${token}`),
  revoke: (id: string, version: number) =>
    request(app)
      .post(`/api/v1/identity/invitations/${id}/revoke`)
      .set('Authorization', `Bearer ${token}`)
      .send({ version }),
});

const rowOf = async (id: string) =>
  (await db.query('select * from core.invitations where id = $1', [id])).rows[0] as Record<string, unknown>;
const versionOf = async (id: string) => (await rowOf(id)).version as number;
const auditOf = (id: string) =>
  db.query<{ action: string; before: unknown; after: unknown; actor_id: string }>(
    "select action, before, after, actor_id from core.audit_logs where entity_id = $1 and action = 'update' order by id",
    [id],
  );

let company: Awaited<ReturnType<typeof createCompany>>;
let ceoId: string;
let ceo: ReturnType<typeof as>;

beforeAll(async () => {
  company = await createCompany();
  ceoId = await accountIdOf(company.ceo.email);
  ceo = as(company.ceo.token);
});

describe('tab "Link đã tạo": GET /invitations?status=open,claimed', () => {
  it('AC 4: liệt kê link open (chưa lộ email) và claimed (có email), không gồm yêu cầu đã nộp', async () => {
    const open = await newLink(app, company.ceo.token, [SALE]);
    const claimed = await newLink(app, company.ceo.token, [SALE]);
    const email = uniqueEmail('dang-ky');
    await claimLink(app, claimed.token, email);
    const submitted = await pendingInvitation(company.companyId, { createdBy: ceoId, roleIds: [SALE] });

    const res = await ceo.list('open,claimed');
    expect(res.status).toBe(200);
    const byId = new Map((res.body.items as { id: string; status: string; email: string | null }[]).map((i) => [i.id, i]));
    expect(byId.get(open.id)).toMatchObject({ status: 'open', email: null });
    expect(byId.get(claimed.id)).toMatchObject({ status: 'claimed', email });
    expect(byId.has(submitted.id)).toBe(false);
    expect(res.body.items.every((i: { status: string }) => ['open', 'claimed'].includes(i.status))).toBe(true);
  });

  it('mặc định vẫn là pending; trạng thái lạ trong danh sách → 422 errors.status', async () => {
    const def = await ceo.list();
    expect(def.status).toBe(200);
    expect(def.body.items.every((i: { status: string }) => i.status === 'pending')).toBe(true);
    for (const bad of ['nope', 'open,nope', '']) {
      const res = await ceo.list(bad);
      expect(res.status, bad).toBe(422);
      expect(res.body.errors.status).toBeTruthy();
    }
  });

  it('lọc được trạng thái revoked', async () => {
    const link = await newLink(app, company.ceo.token, [SALE]);
    await ceo.revoke(link.id, await versionOf(link.id));
    const res = await ceo.list('revoked');
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { id: string }) => i.id)).toContain(link.id);
  });
});

describe('POST /invitations/:id/revoke', () => {
  it('AC 5: huỷ link open → 200 revoked, ghi người huỷ, nhật ký update; mở link → 410 invitation_invalid', async () => {
    const link = await newLink(app, company.ceo.token, [SALE]);
    const res = await ceo.revoke(link.id, await versionOf(link.id));
    expect(res.status).toBe(200);
    expect(res.body.invitation).toMatchObject({ id: link.id, status: 'revoked', email: null });
    expect(res.body.invitation.decidedAt).toBeTruthy();
    expect(await rowOf(link.id)).toMatchObject({ status: 'revoked', decided_by: ceoId });
    expect((await auditOf(link.id)).rows).toEqual([
      { action: 'update', actor_id: ceoId, before: { status: 'open' }, after: { status: 'revoked' } },
    ]);

    const check = await join.check(link.token);
    expect(check.status).toBe(410);
    expect(check.body.code).toBe('invitation_invalid');
    const otp = await join.otp(link.token, uniqueEmail('muon'));
    expect(otp.status).toBe(410);
    expect(otp.body.code).toBe('invitation_invalid');
  });

  it('AC 5 / US-CT-06 AC 8: huỷ link claimed → nhập mã, nộp đều 410 invitation_invalid; mã OTP bị xoá', async () => {
    const link = await newLink(app, company.ceo.token, [SALE]);
    const email = uniqueEmail('bi-huy');
    const { registrationToken } = await claimLink(app, link.token, email);

    const res = await ceo.revoke(link.id, await versionOf(link.id));
    expect(res.status).toBe(200);
    expect(res.body.invitation).toMatchObject({ status: 'revoked', email });
    expect(await rowOf(link.id)).toMatchObject({ otp_hash: null, otp_expires_at: null });

    const complete = await join.complete({ registrationToken, password: PASSWORD, confirmPassword: PASSWORD });
    expect(complete.status).toBe(410);
    expect(complete.body.code).toBe('invitation_invalid');
    const verify = await join.verify(link.token, email, '123456');
    expect(verify.status).toBe(410);
    expect(verify.body.code).toBe('invitation_invalid');
    expect((await rowOf(link.id)).status).toBe('revoked');
  });

  it('link đã quá hạn vẫn huỷ được', async () => {
    const link = await newLink(app, company.ceo.token, [SALE]);
    await db.query("update core.invitations set expires_at = now() - interval '1 minute' where id = $1", [link.id]);
    const res = await ceo.revoke(link.id, await versionOf(link.id));
    expect(res.status).toBe(200);
    expect(res.body.invitation.status).toBe('revoked');
  });

  it('AC 6: yêu cầu đã nộp, lệch version, đã huỷ → 409 version_conflict kèm current; không đổi gì', async () => {
    const submitted = await pendingInvitation(company.companyId, { createdBy: ceoId, roleIds: [SALE] });
    const onPending = await ceo.revoke(submitted.id, submitted.version);
    expect(onPending.status).toBe(409);
    expect(onPending.body.code).toBe('version_conflict');
    expect(onPending.body.current).toMatchObject({ id: submitted.id, status: 'pending' });
    expect((await rowOf(submitted.id)).status).toBe('pending');

    const link = await newLink(app, company.ceo.token, [SALE]);
    const version = await versionOf(link.id);
    const stale = await ceo.revoke(link.id, version + 1);
    expect(stale.status).toBe(409);
    expect(stale.body.current).toMatchObject({ status: 'open', version });

    expect((await ceo.revoke(link.id, version)).status).toBe(200);
    const again = await ceo.revoke(link.id, version + 1);
    expect(again.status).toBe(409);
    expect(again.body.current.status).toBe('revoked');
  });

  it('không có, sai dạng, của công ty khác → 404; Sale không có quyền → 403; thiếu version → 422', async () => {
    expect((await ceo.revoke(randomUUID(), 1)).status).toBe(404);
    expect((await ceo.revoke('khong-phai-uuid', 1)).status).toBe(404);
    const other = await createCompany();
    const foreign = await newLink(app, other.ceo.token, [SALE]);
    expect((await ceo.revoke(foreign.id, await versionOf(foreign.id))).status).toBe(404);

    const link = await newLink(app, company.ceo.token, [SALE]);
    const sale = await addMember(company.companyId, 'sale');
    const denied = await as(sale.token).revoke(link.id, await versionOf(link.id));
    expect(denied.status).toBe(403);
    const noVersion = await request(app)
      .post(`/api/v1/identity/invitations/${link.id}/revoke`)
      .set('Authorization', `Bearer ${company.ceo.token}`)
      .send({});
    expect(noVersion.status).toBe(422);
    expect((await rowOf(link.id)).status).toBe('open');
  });
});
