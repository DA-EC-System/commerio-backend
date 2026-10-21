import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { BUILTIN_ROLES } from '#src/modules/access/domain/catalog.ts';
import { verifyPurposeToken } from '#src/shared/auth/purpose-token.ts';
import { addMember, createCompany, createCustomRole, uniqueEmail } from '../helpers/company.ts';
import { testPool } from '../helpers/db.ts';
import { login, PASSWORD, testApp } from '../helpers/http.ts';
import { raceBehindLock } from '../helpers/locks.ts';
import { accountIdOf, pendingInvitation } from './helpers.ts';

const app = testApp();
const db = testPool();
const SALE = BUILTIN_ROLES.sale.id;

const as = (token: string) => ({
  create: (roleIds: unknown) =>
    request(app).post('/api/v1/identity/invitations').set('Authorization', `Bearer ${token}`).send({ roleIds }),
  list: (query: Record<string, string> = {}) =>
    request(app).get('/api/v1/identity/invitations').query(query).set('Authorization', `Bearer ${token}`),
  approve: (id: string, version: number) =>
    request(app)
      .post(`/api/v1/identity/invitations/${id}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ version }),
  reject: (id: string, version: number) =>
    request(app)
      .post(`/api/v1/identity/invitations/${id}/reject`)
      .set('Authorization', `Bearer ${token}`)
      .send({ version }),
});

const invitationRow = async (id: string) =>
  (await db.query('select * from staff.invitations where id = $1', [id])).rows[0] as Record<string, unknown>;
const invitationCount = async (companyId: string) =>
  Number((await db.query('select count(*) from staff.invitations where company_id = $1', [companyId])).rows[0].count);
const auditOf = (entityId: string) =>
  db.query<{ action: string; entity_type: string; actor_id: string; before: unknown; after: unknown }>(
    'select action, entity_type, actor_id, before, after from audit.audit_logs where entity_id = $1 order by id',
    [entityId],
  );

let company: Awaited<ReturnType<typeof createCompany>>;
let ceoId: string;
let ceo: ReturnType<typeof as>;

beforeAll(async () => {
  company = await createCompany();
  ceoId = await accountIdOf(company.ceo.email);
  ceo = as(company.ceo.token);
});

const pending = (options: { roleIds?: string[]; email?: string; existingAccountId?: string } = {}) =>
  pendingInvitation(company.companyId, { createdBy: ceoId, roleIds: [SALE], ...options });

// API phía Admin của lời mời (#7 [C], spec 6.5, 6.7 "Approve", "Reject"; AC-C1, C2, C12–C18).
describe('tạo link mời', () => {
  it('AC-C1: vai trò hợp lệ → 201 { id, link, expiresAt }, link một lần sống 72 giờ, dòng open, nhật ký create', async () => {
    const res = await ceo.create([SALE]);
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(['expiresAt', 'id', 'link']);
    const [base, token] = (res.body.link as string).split('#');
    expect(base).toBe('https://commerio.test/tham-gia');
    const claims = await verifyPurposeToken('invite', token!);
    expect(claims).toMatchObject({ jti: res.body.id, cid: company.companyId });
    const row = await invitationRow(res.body.id);
    expect(row).toMatchObject({ status: 'open', role_ids: [SALE], created_by: ceoId, email: null });
    expect((row.expires_at as Date).getTime() - (row.created_at as Date).getTime()).toBe(72 * 3600_000);
    expect(new Date(res.body.expiresAt).getTime()).toBe((row.expires_at as Date).getTime());
    expect((await auditOf(res.body.id)).rows).toEqual([
      { action: 'create', entity_type: 'staff.invitations', actor_id: ceoId, before: null, after: { roles: [SALE] } },
    ]);
  });

  it('AC-C2: có CEO → 403 protected_account; quyền người gọi không có → 403 permission_not_held; roleIds sai → 422; Sale → 403. Không tạo dòng nào', async () => {
    const own = await createCompany();
    const admin = await addMember(own.companyId, 'admin');
    const sale = await addMember(own.companyId, 'sale');
    const finance = await createCustomRole(own.companyId, ['inventory.cost.view']);
    const ownCeo = as(own.ceo.token);
    const cases: [request.Test, number, string][] = [
      [ownCeo.create([BUILTIN_ROLES.ceo.id]), 403, 'protected_account'],
      [as(admin.token).create([finance]), 403, 'permission_not_held'],
      [ownCeo.create([randomUUID()]), 422, 'validation_failed'],
      [ownCeo.create([]), 422, 'validation_failed'],
      [ownCeo.create(['khong-phai-uuid']), 422, 'validation_failed'],
      [as(sale.token).create([SALE]), 403, 'forbidden'],
    ];
    for (const [call, status, code] of cases) {
      const res = await call;
      expect(res.status, code).toBe(status);
      expect(res.body.code).toBe(code);
      if (status === 422) expect(Object.keys(res.body.errors)).toEqual(['roleIds']);
    }
    // Vai trò tuỳ biến của công ty khác cũng là "không tồn tại".
    expect((await ownCeo.create([await createCustomRole(company.companyId, [])])).status).toBe(422);
    expect(await invitationCount(own.companyId)).toBe(0);
  });

  it('Admin tạo được link cho vai trò gồm quyền mình có; vai trò Sale có quyền giao hàng mà Admin không có (Documents/21 mục 8)', async () => {
    const admin = await addMember(company.companyId, 'admin');
    expect((await as(admin.token).create([BUILTIN_ROLES.admin.id])).status).toBe(201);
    expect((await as(admin.token).create([SALE])).body.code).toBe('permission_not_held');
  });
});

describe('hàng đợi lời mời', () => {
  it('AC-C12: status=pending chỉ gồm lời mời của công ty, đủ trường, không lộ mật khẩu', async () => {
    const own = await createCompany();
    const ownCeoId = await accountIdOf(own.ceo.email);
    const other = await createCompany();
    const existing = await addMember(other.companyId, 'sale');
    const fresh = await pendingInvitation(own.companyId, { createdBy: ownCeoId, roleIds: [SALE] });
    const known = await pendingInvitation(own.companyId, {
      createdBy: ownCeoId,
      roleIds: [SALE],
      existingAccountId: existing.accountId,
      email: existing.email,
    });
    await pendingInvitation(other.companyId, { createdBy: await accountIdOf(other.ceo.email), roleIds: [SALE] });
    const open = await as(own.ceo.token).create([SALE]);

    const res = await as(own.ceo.token).list();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 2, page: 1, pageSize: 20 });
    expect(res.body.items.map((i: { id: string }) => i.id).sort()).toEqual([fresh.id, known.id].sort());
    const item = res.body.items.find((i: { id: string }) => i.id === known.id);
    expect(item).toMatchObject({
      status: 'pending',
      expired: false,
      email: existing.email,
      fullName: 'Nhân Viên Mới',
      roles: [{ id: SALE, name: 'Sale' }],
      outdated: false,
      existingAccount: true,
      createdBy: { id: ownCeoId },
      decidedAt: null,
      version: 1,
    });
    expect(typeof item.submittedAt).toBe('string');
    expect(res.body.items.find((i: { id: string }) => i.id === fresh.id).existingAccount).toBe(false);
    expect(JSON.stringify(res.body)).not.toMatch(/argon2|password|otp/i);

    // Người cầm link đã xin mã (email, họ tên chưa xác minh) mà lời mời còn open: không lộ cho Admin.
    await db.query("update staff.invitations set email = $2, full_name = 'Người Lạ' where id = $1", [
      open.body.id,
      uniqueEmail('chua-xac-minh'),
    ]);
    const opened = await as(own.ceo.token).list({ status: 'open' });
    expect(opened.body.items.map((i: { id: string }) => i.id)).toEqual([open.body.id]);
    expect(opened.body.items[0]).toMatchObject({ email: null, fullName: null, submittedAt: null });
  });

  it('status lạ → 422; Sale không có quyền xem → 403', async () => {
    expect((await ceo.list({ status: 'expired' })).status).toBe(422);
    const sale = await addMember(company.companyId, 'sale');
    expect((await as(sale.token).list()).status).toBe(403);
  });
});

describe('duyệt, từ chối', () => {
  it('AC-C13: duyệt email mới → tạo tài khoản đúng mật khẩu, membership active, đúng vai trò, nhật ký create; nhân viên đăng nhập được', async () => {
    const inv = await pending();
    const res = await ceo.approve(inv.id, inv.version);
    expect(res.status).toBe(200);
    expect(res.body.invitation).toMatchObject({ id: inv.id, status: 'approved', version: inv.version + 1 });
    expect(res.body.member).toMatchObject({
      email: inv.email,
      fullName: 'Nhân Viên Mới',
      roles: [{ id: SALE, name: 'Sale' }],
      status: 'active',
      isCeo: false,
      pendingFirstLogin: false,
    });
    const accountId = res.body.member.accountId as string;
    const row = await invitationRow(inv.id);
    expect(row).toMatchObject({ status: 'approved', account_id: accountId, decided_by: ceoId, password_hash: null });
    const membership = await db.query<{ id: string; status: string }>(
      'select id, status from staff.memberships where company_id = $1 and account_id = $2',
      [company.companyId, accountId],
    );
    expect(membership.rows[0]!.status).toBe('active');
    expect((await auditOf(membership.rows[0]!.id)).rows).toEqual([
      {
        action: 'create',
        entity_type: 'staff.memberships',
        actor_id: ceoId,
        before: null,
        after: { invitationId: inv.id, roles: [SALE] },
      },
    ]);
    const { body } = await login(inv.email, PASSWORD);
    expect(body.memberships.map((m: { companyId: string }) => m.companyId)).toEqual([company.companyId]);
  });

  it('AC-C14: duyệt tài khoản đã có → chỉ thêm membership và vai trò, không tạo tài khoản, không đổi mật khẩu', async () => {
    const other = await createCompany();
    const existing = await addMember(other.companyId, 'sale');
    const before = await db.query('select password_hash, version from staff.accounts where id = $1', [
      existing.accountId,
    ]);
    const inv = await pending({ existingAccountId: existing.accountId, email: existing.email });
    const res = await ceo.approve(inv.id, inv.version);
    expect(res.status).toBe(200);
    expect(res.body.member.accountId).toBe(existing.accountId);
    expect(
      (await db.query('select count(*) from staff.accounts where email = $1', [existing.email])).rows[0].count,
    ).toBe('1');
    expect(
      (await db.query('select password_hash, version from staff.accounts where id = $1', [existing.accountId])).rows,
    ).toEqual(before.rows);
    const { body } = await login(existing.email);
    expect(body.memberships).toHaveLength(2);
  });

  it('AC-C15: từ chối → rejected, không tạo gì, nhật ký update', async () => {
    const inv = await pending();
    const res = await ceo.reject(inv.id, inv.version);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['invitation']);
    expect(res.body.invitation).toMatchObject({ status: 'rejected', version: inv.version + 1 });
    expect(await invitationRow(inv.id)).toMatchObject({ status: 'rejected', decided_by: ceoId, password_hash: null });
    expect((await db.query('select 1 from staff.accounts where email = $1', [inv.email])).rowCount).toBe(0);
    expect((await auditOf(inv.id)).rows).toEqual([
      {
        action: 'update',
        entity_type: 'staff.invitations',
        actor_id: ceoId,
        before: { status: 'pending' },
        after: { status: 'rejected' },
      },
    ]);
  });

  it('AC-C16: vai trò đã bị xoá → 409 invitation_outdated; có CEO → 403 protected_account; người duyệt thiếu quyền → 403 permission_not_held. Không tạo gì', async () => {
    const admin = await addMember(company.companyId, 'admin');
    const finance = await createCustomRole(company.companyId, ['inventory.cost.view']);
    const cases: [Awaited<ReturnType<typeof pending>>, ReturnType<typeof as>, number, string][] = [
      [await pending({ roleIds: [SALE, randomUUID()] }), ceo, 409, 'invitation_outdated'],
      [await pending({ roleIds: [BUILTIN_ROLES.ceo.id] }), ceo, 403, 'protected_account'],
      [await pending({ roleIds: [finance] }), as(admin.token), 403, 'permission_not_held'],
    ];
    for (const [inv, who, status, code] of cases) {
      const res = await who.approve(inv.id, inv.version);
      expect(res.status, code).toBe(status);
      expect(res.body.code).toBe(code);
      expect(await invitationRow(inv.id)).toMatchObject({ status: 'pending', version: inv.version });
      expect((await db.query('select 1 from staff.accounts where email = $1', [inv.email])).rowCount).toBe(0);
    }
  });

  it('AC-C16: email đã có tài khoản do đường khác → 409 email_taken; đã là thành viên → 409 already_member', async () => {
    const taken = await pending();
    await db.query("insert into staff.accounts (email, full_name) values ($1, 'Đăng Ký Riêng')", [taken.email]);
    const takenRes = await ceo.approve(taken.id, taken.version);
    expect(takenRes.status).toBe(409);
    expect(takenRes.body.code).toBe('email_taken');

    const member = await addMember(company.companyId, 'sale');
    const again = await pending({ existingAccountId: member.accountId, email: member.email });
    const againRes = await ceo.approve(again.id, again.version);
    expect(againRes.status).toBe(409);
    expect(againRes.body.code).toBe('already_member');

    // Email mới nhưng tài khoản mang email đó đã vào công ty bằng đường khác: already_member trước email_taken.
    const joined = await pending({ email: (await addMember(company.companyId, 'sale')).email });
    expect((await ceo.approve(joined.id, joined.version)).body.code).toBe('already_member');
    for (const inv of [taken, again, joined]) expect((await invitationRow(inv.id)).status).toBe('pending');
  });

  it('AC-C17: version lệch hay đã quyết định → 409 version_conflict kèm current', async () => {
    const inv = await pending();
    const stale = await ceo.approve(inv.id, inv.version + 5);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_conflict');
    expect(stale.body.current).toMatchObject({ id: inv.id, status: 'pending', version: inv.version });
    expect((await ceo.reject(inv.id, inv.version)).status).toBe(200);
    const decided = await ceo.approve(inv.id, inv.version + 1);
    expect(decided.status).toBe(409);
    expect(decided.body.current).toMatchObject({ status: 'rejected', version: inv.version + 1 });
    expect((await ceo.reject(inv.id, inv.version + 1)).body.code).toBe('version_conflict');
  });

  it('AC-C18: id của công ty khác, không tồn tại, không phải uuid → 404; Sale duyệt → 403', async () => {
    const other = await createCompany();
    const foreign = await pendingInvitation(other.companyId, {
      createdBy: await accountIdOf(other.ceo.email),
      roleIds: [SALE],
    });
    for (const id of [foreign.id, randomUUID(), 'khong-phai-uuid']) {
      expect((await ceo.approve(id, 1)).status).toBe(404);
      expect((await ceo.reject(id, 1)).status).toBe(404);
    }
    expect((await invitationRow(foreign.id)).status).toBe('pending');
    const sale = await addMember(company.companyId, 'sale');
    const inv = await pending();
    expect((await as(sale.token).approve(inv.id, inv.version)).body.code).toBe('forbidden');
    expect((await as(sale.token).reject(inv.id, inv.version)).body.code).toBe('forbidden');
  });

  it('Review Focus 4: link đã quá 72 giờ nhưng yêu cầu đã pending thì vẫn duyệt được', async () => {
    const inv = await pending();
    await db.query("update staff.invitations set expires_at = now() - interval '1 hour' where id = $1", [inv.id]);
    expect((await ceo.approve(inv.id, inv.version)).status).toBe(200);
  });
});

// Chạy đua tất định (spec 6.7, 6.14): giao dịch giữ khoá đóng vai phiên đang duyệt dở; các request đua bị chặn sau nó.
const lockInvitation = (id: string) => (holder: PoolClient) =>
  holder.query('select 1 from staff.invitations where id = $1 for update', [id]);

describe('duyệt chạy đồng thời', () => {
  it('hai Admin duyệt cùng lúc: một 200, một 409 version_conflict; chỉ một tài khoản, một membership', async () => {
    const admin = await addMember(company.companyId, 'admin');
    const inv = await pending();
    const results = await raceBehindLock(lockInvitation(inv.id), 2, () =>
      Promise.all([ceo.approve(inv.id, inv.version), as(admin.token).approve(inv.id, inv.version)]),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe('version_conflict');
    const accounts = await db.query<{ id: string }>('select id from staff.accounts where email = $1', [inv.email]);
    expect(accounts.rows).toHaveLength(1);
    const memberships = await db.query('select 1 from staff.memberships where account_id = $1', [accounts.rows[0]!.id]);
    expect(memberships.rowCount).toBe(1);
  });

  it('duyệt và từ chối cùng lúc: đúng một bên thắng, bên kia 409 version_conflict', async () => {
    const inv = await pending();
    const [approved, rejected] = await raceBehindLock(lockInvitation(inv.id), 2, () =>
      Promise.all([ceo.approve(inv.id, inv.version), ceo.reject(inv.id, inv.version)]),
    );
    expect([approved.status, rejected.status].sort()).toEqual([200, 409]);
    expect([approved, rejected].find((r) => r.status === 409)!.body.code).toBe('version_conflict');
    const status = (await invitationRow(inv.id)).status;
    expect(status).toBe(approved.status === 200 ? 'approved' : 'rejected');
    const accounts = await db.query('select 1 from staff.accounts where email = $1', [inv.email]);
    expect(accounts.rowCount).toBe(status === 'approved' ? 1 : 0);
  });

  it('tài khoản cùng email vừa được tạo ở phiên khác lúc đang duyệt (vd lời mời ở công ty khác) → 409 email_taken, không tạo gì', async () => {
    const inv = await pending();
    // Phiên giữ khoá chèn tài khoản cùng email mà chưa commit: lúc duyệt chưa thấy, câu INSERT bị chặn ở unique.
    const res = await raceBehindLock(
      (holder) => holder.query("insert into staff.accounts (email, full_name) values ($1, 'Phiên Khác')", [inv.email]),
      1,
      () => ceo.approve(inv.id, inv.version),
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('email_taken');
    expect(await invitationRow(inv.id)).toMatchObject({ status: 'pending', version: inv.version });
    const accounts = await db.query<{ id: string }>('select id from staff.accounts where email = $1', [inv.email]);
    expect(accounts.rows).toHaveLength(1);
    expect(
      (await db.query('select 1 from staff.memberships where account_id = $1', [accounts.rows[0]!.id])).rowCount,
    ).toBe(0);
  });
});
