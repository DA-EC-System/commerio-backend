import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { BUILTIN_ROLES } from '#src/modules/core/access/domain/catalog.ts';
import { addMember, createCompany, createCustomRole } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { login, testApp } from '../../helpers/http.ts';
import { raceBehindLock } from '../../helpers/locks.ts';

const app = testApp();
const db = testPool();

const get = (path: string, token: string) => request(app).get(path).set('Authorization', `Bearer ${token}`);
const putRoles = (token: string, accountId: string, body: object) =>
  request(app).put(`/api/v1/identity/staff/${accountId}/roles`).set('Authorization', `Bearer ${token}`).send(body);
const lock = (token: string, accountId: string, version: number, action: 'lock' | 'unlock' = 'lock') =>
  request(app).post(`/api/v1/identity/staff/${accountId}/${action}`).set('Authorization', `Bearer ${token}`).send({ version });
const memberAudits = (membershipId: string) =>
  db.query(
    "select action, before, after from audit.audit_logs where entity_type = 'staff.memberships' and entity_id = $1 order by id",
    [membershipId],
  );

async function rename(accountId: string, fullName: string) {
  await db.query('update staff.accounts set full_name = $2 where id = $1', [accountId, fullName]);
}

// Quản lý nhân viên (#7 [B], spec 6.5, AC-B1..B7).
describe('danh sách nhân viên', () => {
  it('AC-B1: chỉ gồm nhân viên công ty của token, có phân trang, tìm không phân biệt hoa thường', async () => {
    const a = await createCompany();
    const b = await createCompany();
    const sale = await addMember(a.companyId, 'sale');
    await rename(sale.accountId, 'Trần Thị Bán Hàng');
    await addMember(b.companyId, 'sale');
    const res = await get('/api/v1/identity/staff', a.ceo.token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 2, page: 1, pageSize: 20 });
    expect(res.body.items.map((m: { email: string }) => m.email).sort()).toEqual([a.ceo.email, sale.email].sort());
    const ceo = res.body.items.find((m: { email: string }) => m.email === a.ceo.email);
    expect(ceo).toMatchObject({ isCeo: true, status: 'active', roles: [{ id: BUILTIN_ROLES.ceo.id, name: 'CEO' }] });
    expect(Object.keys(ceo).sort()).toEqual(
      ['accountId', 'email', 'fullName', 'isCeo', 'joinedAt', 'pendingFirstLogin', 'roles', 'status', 'version'].sort(),
    );
    const found = await get(`/api/v1/identity/staff?search=${encodeURIComponent('bán HÀNG')}`, a.ceo.token);
    expect(found.body.items.map((m: { accountId: string }) => m.accountId)).toEqual([sale.accountId]);
    const page2 = await get('/api/v1/identity/staff?pageSize=1&page=2', a.ceo.token);
    expect(page2.body).toMatchObject({ total: 2, page: 2, pageSize: 1 });
    expect(page2.body.items).toHaveLength(1);
  });

  it('lọc theo trạng thái và vai trò', async () => {
    const a = await createCompany();
    const sale = await addMember(a.companyId, 'sale');
    const kho = await addMember(a.companyId, 'warehouse');
    await db.query("update staff.memberships set status = 'suspended' where id = $1", [kho.membershipId]);
    const locked = await get('/api/v1/identity/staff?status=locked', a.ceo.token);
    expect(locked.body.items.map((m: { accountId: string }) => m.accountId)).toEqual([kho.accountId]);
    const sales = await get(`/api/v1/identity/staff?roleId=${BUILTIN_ROLES.sale.id}`, a.ceo.token);
    expect(sales.body.items.map((m: { accountId: string }) => m.accountId)).toEqual([sale.accountId]);
    expect((await get('/api/v1/identity/staff?roleId=abc', a.ceo.token)).status).toBe(422);
  });

  it('Review Focus 3: tìm "%" và "_" khớp đúng chuỗi, không thành ký tự đại diện', async () => {
    const a = await createCompany();
    const odd = await addMember(a.companyId, 'sale');
    await rename(odd.accountId, 'Nguyễn 50%_Thử');
    const plain = await addMember(a.companyId, 'sale');
    await rename(plain.accountId, 'Nguyễn 500 Thử');
    const res = await get(`/api/v1/identity/staff?search=${encodeURIComponent('50%_')}`, a.ceo.token);
    expect(res.body.items.map((m: { fullName: string }) => m.fullName)).toEqual(['Nguyễn 50%_Thử']);
    const slash = await get(`/api/v1/identity/staff?search=${encodeURIComponent('\\')}`, a.ceo.token);
    expect(slash.status).toBe(200);
    expect(slash.body.items).toEqual([]);
  });

  it('AC-B1: thiếu identity.account.view → 403', async () => {
    const a = await createCompany();
    const sale = await addMember(a.companyId, 'sale');
    expect((await get('/api/v1/identity/staff', sale.token)).body.code).toBe('forbidden');
  });
});

describe('đổi vai trò', () => {
  it('AC-B2: hợp lệ → 200 StaffMember mới, version tăng, nhật ký có vai trò trước và sau, request kế tiếp dùng quyền mới', async () => {
    const a = await createCompany();
    const target = await addMember(a.companyId, 'sale');
    expect((await get('/api/v1/identity/staff', target.token)).status).toBe(403);
    const res = await putRoles(a.ceo.token, target.accountId, { roleIds: [BUILTIN_ROLES.admin.id], version: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accountId: target.accountId, version: 2, roles: [{ id: BUILTIN_ROLES.admin.id, name: 'Admin' }] });
    expect((await memberAudits(target.membershipId)).rows).toEqual([
      { action: 'update', before: { roles: [BUILTIN_ROLES.sale.id] }, after: { roles: [BUILTIN_ROLES.admin.id] } },
    ]);
    expect((await get('/api/v1/identity/staff', target.token)).status).toBe(200);
  });

  it('AC-B3: thêm hay gỡ vai trò có quyền người gọi không có → 403 permission_not_held; gán CEO → 403 protected_account', async () => {
    const a = await createCompany();
    const admin = await addMember(a.companyId, 'admin');
    const target = await addMember(a.companyId, 'warehouse');
    const custom = await createCustomRole(a.companyId, ['identity.account.view']);
    // Gỡ "Nhân viên kho" (có quyền lập phiếu Admin không có).
    const removing = await putRoles(admin.token, target.accountId, { roleIds: [custom], version: 1 });
    expect(removing.status).toBe(403);
    expect(removing.body.code).toBe('permission_not_held');
    const ceoRole = await putRoles(admin.token, target.accountId, { roleIds: [BUILTIN_ROLES.ceo.id], version: 1 });
    expect(ceoRole.body.code).toBe('protected_account');
    const plain = await addMember(a.companyId, custom);
    const adding = await putRoles(admin.token, plain.accountId, { roleIds: [custom, BUILTIN_ROLES.kho.id], version: 1 });
    expect(adding.body.code).toBe('permission_not_held');
    expect((await memberAudits(target.membershipId)).rows).toEqual([]);
  });

  it('AC-B3: roleIds rỗng, không tồn tại, của công ty khác → 422 errors.roleIds', async () => {
    const a = await createCompany();
    const b = await createCompany();
    const target = await addMember(a.companyId, 'sale');
    const foreign = await createCustomRole(b.companyId, ['sales.order.view']);
    for (const roleIds of [[], [randomUUID()], [foreign], ['khong-phai-uuid']]) {
      const res = await putRoles(a.ceo.token, target.accountId, { roleIds, version: 1 });
      expect(res.status, JSON.stringify(roleIds)).toBe(422);
      expect(Object.keys(res.body.errors)).toEqual(['roleIds']);
    }
  });

  it('AC-B4: đích là CEO hoặc chính người gọi → 403 protected_account cho đổi vai trò, khoá, mở khoá', async () => {
    const a = await createCompany();
    const admin = await addMember(a.companyId, 'admin');
    const ceoId = (await db.query<{ id: string }>('select id from staff.accounts where email = $1', [a.ceo.email])).rows[0]!.id;
    for (const [token, accountId] of [
      [admin.token, ceoId],
      [admin.token, admin.accountId],
      [a.ceo.token, ceoId],
    ] as const) {
      expect((await putRoles(token, accountId, { roleIds: [BUILTIN_ROLES.sale.id], version: 1 })).body.code).toBe('protected_account');
      expect((await lock(token, accountId, 1)).body.code).toBe('protected_account');
      expect((await lock(token, accountId, 1, 'unlock')).body.code).toBe('protected_account');
    }
  });

  it('AC-B4: id của chính mình viết hoa vẫn là chính mình → 403 protected_account, không tự khoá được', async () => {
    const a = await createCompany();
    const admin = await addMember(a.companyId, 'admin');
    const custom = await createCustomRole(a.companyId, ['identity.account.view']);
    const upper = admin.accountId.toUpperCase();
    expect((await putRoles(admin.token, upper, { roleIds: [custom], version: 1 })).body.code).toBe('protected_account');
    expect((await lock(admin.token, upper, 1)).body.code).toBe('protected_account');
    expect((await get('/api/v1/identity/staff', admin.token)).status).toBe(200);
  });

  it('AC-B6: version lệch → 409 version_conflict kèm current mới nhất, không đổi gì, không ghi nhật ký', async () => {
    const a = await createCompany();
    const target = await addMember(a.companyId, 'sale');
    const res = await putRoles(a.ceo.token, target.accountId, { roleIds: [BUILTIN_ROLES.admin.id], version: 7 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('version_conflict');
    expect(res.body.current).toMatchObject({ accountId: target.accountId, version: 1, roles: [{ id: BUILTIN_ROLES.sale.id }] });
    expect((await memberAudits(target.membershipId)).rows).toEqual([]);
  });
});

describe('khoá, mở khoá', () => {
  it('AC-B5: khoá → locked, version tăng, nhật ký; token cũ của người bị khoá → 403 account_locked; mở khoá làm ngược lại', async () => {
    const a = await createCompany();
    const target = await addMember(a.companyId, 'admin');
    const res = await lock(a.ceo.token, target.accountId, 1);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'locked', version: 2 });
    expect((await get('/api/v1/identity/staff', target.token)).body.code).toBe('account_locked');
    const { token } = await login(target.email);
    const select = await request(app)
      .post('/api/v1/identity/select-company')
      .set('Authorization', `Bearer ${token}`)
      .send({ companyId: a.companyId });
    expect(select.body.code).toBe('account_locked');
    const unlock = await lock(a.ceo.token, target.accountId, 2, 'unlock');
    expect(unlock.body).toMatchObject({ status: 'active', version: 3 });
    expect((await get('/api/v1/identity/staff', target.token)).status).toBe(200);
    expect((await memberAudits(target.membershipId)).rows).toEqual([
      { action: 'update', before: { status: 'active' }, after: { status: 'locked' } },
      { action: 'update', before: { status: 'locked' }, after: { status: 'active' } },
    ]);
  });

  it('AC-B6: đã ở trạng thái đích → 409 version_conflict kèm current', async () => {
    const a = await createCompany();
    const target = await addMember(a.companyId, 'sale');
    const res = await lock(a.ceo.token, target.accountId, 1, 'unlock');
    expect(res.status).toBe(409);
    expect(res.body.current).toMatchObject({ status: 'active', version: 1 });
  });

  it('hai lần khoá cùng version chạy song song: một 200, một 409', async () => {
    const a = await createCompany();
    const target = await addMember(a.companyId, 'sale');
    // Cả hai đã qua bước so version rồi mới tới câu ghi: người sau chỉ bị chặn ở UPDATE có điều kiện.
    const [x, y] = await raceBehindLock(
      (holder) => holder.query('select 1 from staff.memberships where id = $1 for update', [target.membershipId]),
      2,
      () => Promise.all([lock(a.ceo.token, target.accountId, 1), lock(a.ceo.token, target.accountId, 1)]),
    );
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect((await memberAudits(target.membershipId)).rows).toHaveLength(1);
  });
});

describe('phạm vi và quyền', () => {
  it('AC-B7: accountId của công ty khác, không tồn tại, không phải uuid → 404', async () => {
    const a = await createCompany();
    const b = await createCompany();
    const other = await addMember(b.companyId, 'sale');
    for (const accountId of [other.accountId, randomUUID(), 'abc']) {
      expect((await putRoles(a.ceo.token, accountId, { roleIds: [BUILTIN_ROLES.sale.id], version: 1 })).status).toBe(404);
      expect((await lock(a.ceo.token, accountId, 1)).status).toBe(404);
    }
  });

  it('AC-B7: Sale gọi API ghi → 403 forbidden, kể cả body sai (kiểm quyền trước validate)', async () => {
    const a = await createCompany();
    const sale = await addMember(a.companyId, 'sale');
    const target = await addMember(a.companyId, 'sale');
    expect((await putRoles(sale.token, target.accountId, { roleIds: 'sai' })).body.code).toBe('forbidden');
    expect((await lock(sale.token, target.accountId, 1)).body.code).toBe('forbidden');
  });
});
