import type { PoolClient } from 'pg';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { BUILTIN_ROLES } from '#src/modules/core/access/domain/catalog.ts';
import { addMember, createCompany, createCustomRole } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { login, testApp } from '../../helpers/http.ts';
import { raceBehindLock } from '../../helpers/locks.ts';
import { lockCompany, setModuleEnabled, suspendMembership } from '../../helpers/state.ts';

// API vai trò và quyền (commerio-backend#8, UC-PI-06, Documents/21 mục 3, D2, D3).
const API = '/api/v1/identity';
const BUILTIN_IDS: readonly string[] = Object.values(BUILTIN_ROLES).map((r) => r.id);
const ADMIN_PERMS: readonly string[] = BUILTIN_ROLES.admin.permissions;

type Method = 'get' | 'post' | 'put' | 'delete';
function call(method: Method, path: string, token?: string, body?: object) {
  const req = request(testApp())[method](API + path);
  if (token) req.set('Authorization', `Bearer ${token}`);
  return body ? req.send(body) : req;
}

const roleCount = async (companyId: string) =>
  Number((await testPool().query('select count(*) from access.roles where company_id = $1', [companyId])).rows[0].count);

async function roleRow(id: string) {
  const role = await testPool().query('select name, company_id, version from access.roles where id = $1', [id]);
  const perms = await testPool().query<{ permission_code: string }>(
    'select permission_code from access.role_permissions where role_id = $1 order by 1',
    [id],
  );
  return role.rows[0] ? { ...role.rows[0], permissions: perms.rows.map((p) => p.permission_code) } : undefined;
}

const auditOf = async (entityId: string) =>
  (
    await testPool().query(
      "select action, company_id, actor_id, before, after from audit.audit_logs where entity_type = 'access.roles' and entity_id = $1 order by id",
      [entityId],
    )
  ).rows;

/** Admin của một công ty mới, kèm token đã chọn công ty. */
async function companyWithAdmin() {
  const company = await createCompany();
  const admin = await addMember(company.companyId, 'admin');
  return { ...company, admin };
}

async function createRole(token: string, name: string, permissions: string[]) {
  const res = await call('post', '/roles', token, { name, permissions });
  expect(res.status).toBe(201);
  return res.body as { id: string; version: number; name: string; permissions: string[] };
}

describe('xác thực và công ty trên route vai trò thật (AC-1, 2, 3, 5, 17)', () => {
  it('AC-1: thiếu token hoặc token sai chữ ký → 401 unauthorized', async () => {
    const { ceo } = await createCompany();
    const none = await call('get', '/roles');
    expect(none.status).toBe(401);
    expect(none.body.code).toBe('unauthorized');
    // Sửa một ký tự ở phần payload: chữ ký không còn khớp.
    const [h, p, sig] = ceo.token.split('.') as [string, string, string];
    const tampered = [h, p.slice(0, -1) + (p.endsWith('A') ? 'B' : 'A'), sig].join('.');
    const bad = await call('get', '/roles', tampered);
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('unauthorized');
  });

  it('AC-2: token chưa chọn công ty → 403 company_not_selected', async () => {
    const { ceo } = await createCompany();
    const { token } = await login(ceo.email);
    const res = await call('get', '/roles', token);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('company_not_selected');
  });

  it('AC-3: Sale thiếu identity.role.manage gửi body sai → 403 forbidden, không 422, không tạo gì', async () => {
    const { companyId } = await createCompany();
    const sale = await addMember(companyId, 'sale');
    const res = await call('post', '/roles', sale.token, {});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden');
    expect(await roleCount(companyId)).toBe(0);
  });

  it('AC-5: công ty bị khoá hoặc tài khoản bị khoá sau khi có token → lần gọi kế tiếp 403', async () => {
    const a = await companyWithAdmin();
    expect((await call('get', '/roles', a.admin.token)).status).toBe(200);
    await suspendMembership(a.admin.membershipId);
    expect((await call('get', '/roles', a.admin.token)).body.code).toBe('account_locked');
    await lockCompany(a.companyId);
    expect((await call('get', '/roles', a.ceo.token)).body.code).toBe('company_locked');
  });
});

describe('GET /identity/permissions (AC-8)', () => {
  it('trả {code, module, label} của phân hệ đang bật, không có platform.*', async () => {
    const { ceo } = await createCompany({ optionalModules: [] });
    const res = await call('get', '/permissions', ceo.token);
    expect(res.status).toBe(200);
    const codes = (res.body as { code: string }[]).map((p) => p.code);
    expect(res.body).toContainEqual({ code: 'identity.role.view', module: 'identity', label: 'Xem vai trò' });
    expect(codes).not.toContain('platform.module.manage');
    expect(codes).not.toContain('platform.audit.view');
    expect(codes.some((c) => c.startsWith('purchasing.'))).toBe(false);
  });

  it('bật purchasing thì có quyền purchasing.*; Sale (thiếu identity.role.view) bị 403', async () => {
    const { companyId, ceo } = await createCompany({ optionalModules: ['purchasing'] });
    const codes = ((await call('get', '/permissions', ceo.token)).body as { code: string }[]).map((p) => p.code);
    expect(codes).toContain('purchasing.order.approve');
    const sale = await addMember(companyId, 'sale');
    expect((await call('get', '/permissions', sale.token)).body.code).toBe('forbidden');
  });
});

describe('GET /identity/roles (AC-6, 9, S-5)', () => {
  it('AC-9: có sẵn trước theo CEO, Admin, Sale, Nhân viên kho, rồi tuỳ biến theo tên; đủ trường', async () => {
    const a = await companyWithAdmin();
    await createRole(a.admin.token, 'Thủ quỹ', ['catalog.product.view']);
    await createRole(a.admin.token, 'Bán hàng online', ['sales.order.view']);
    const res = await call('get', '/roles', a.admin.token);
    expect(res.status).toBe(200);
    expect(res.body.map((r: { name: string }) => r.name)).toEqual([
      'CEO',
      'Admin',
      'Sale',
      'Nhân viên kho',
      'Bán hàng online',
      'Thủ quỹ',
    ]);
    for (const role of res.body) {
      expect(Object.keys(role).sort()).toEqual(['builtIn', 'id', 'memberCount', 'name', 'permissions', 'updatedAt', 'version']);
    }
    const admin = res.body.find((r: { name: string }) => r.name === 'Admin');
    expect(admin).toMatchObject({ builtIn: true, memberCount: 1, permissions: [...ADMIN_PERMS].sort() });
    expect(res.body.find((r: { name: string }) => r.name === 'Thủ quỹ')).toMatchObject({ builtIn: false, memberCount: 0, version: 1 });
  });

  it('AC-6: công ty A chỉ thấy vai trò có sẵn và của A; PUT/DELETE vai trò của B → 404, B không đổi', async () => {
    const a = await companyWithAdmin();
    const b = await companyWithAdmin();
    const roleB = await createRole(b.admin.token, 'Kiểm kho B', ['catalog.product.view']);
    const listA = (await call('get', '/roles', a.admin.token)).body as { id: string }[];
    expect(listA.map((r) => r.id)).not.toContain(roleB.id);
    expect(listA.filter((r) => !BUILTIN_IDS.includes(r.id))).toHaveLength(0);

    const before = await roleRow(roleB.id);
    const put = await call('put', `/roles/${roleB.id}`, a.admin.token, {
      name: 'Đổi tên',
      permissions: ['catalog.product.view'],
      version: 1,
    });
    expect(put.status).toBe(404);
    expect(put.body.code).toBe('not_found');
    const del = await call('delete', `/roles/${roleB.id}?version=1`, a.admin.token);
    expect(del.status).toBe(404);
    expect(del.body.code).toBe('not_found');
    expect(await roleRow(roleB.id)).toEqual(before);
  });

  it('S-6: id không phải uuid → 404 not_found', async () => {
    const a = await companyWithAdmin();
    const put = await call('put', '/roles/abc', a.admin.token, { name: 'X', permissions: ['catalog.product.view'], version: 1 });
    expect(put.status).toBe(404);
    expect((await call('delete', '/roles/abc?version=1', a.admin.token)).status).toBe(404);
  });

  it('S-5: người chỉ có identity.account.view xem được danh sách vai trò, không xem được danh mục quyền', async () => {
    const { companyId } = await createCompany();
    const roleId = await createCustomRole(companyId, ['identity.account.view']);
    const member = await addMember(companyId, roleId);
    expect((await call('get', '/roles', member.token)).status).toBe(200);
    expect((await call('get', '/permissions', member.token)).body.code).toBe('forbidden');
    const sale = await addMember(companyId, 'sale');
    expect((await call('get', '/roles', sale.token)).body.code).toBe('forbidden');
  });
});

describe('POST /identity/roles', () => {
  it('AC-10: tạo vai trò 201, thuộc công ty trong token, có nhật ký create', async () => {
    const a = await companyWithAdmin();
    const res = await call('post', '/roles', a.admin.token, {
      name: '  Chăm sóc khách hàng  ',
      permissions: ['sales.customer.view', 'sales.order.view'],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Chăm sóc khách hàng',
      builtIn: false,
      version: 1,
      memberCount: 0,
      permissions: ['sales.customer.view', 'sales.order.view'],
    });
    expect((await roleRow(res.body.id))?.company_id).toBe(a.companyId);
    const list = (await call('get', '/roles', a.admin.token)).body as { id: string }[];
    expect(list.map((r) => r.id)).toContain(res.body.id);
    expect(await auditOf(res.body.id)).toEqual([
      {
        action: 'create',
        company_id: a.companyId,
        actor_id: a.admin.accountId,
        before: null,
        after: { name: 'Chăm sóc khách hàng', permissions: ['sales.customer.view', 'sales.order.view'] },
      },
    ]);
  });

  it('AC-11, S-4: dữ liệu sai → 422 theo ô name / permissions, không lưu gì', async () => {
    const a = await companyWithAdmin();
    const cases: [object, string][] = [
      [{ permissions: ['catalog.product.view'] }, 'name'],
      [{ name: '   ', permissions: ['catalog.product.view'] }, 'name'],
      [{ name: 'x'.repeat(61), permissions: ['catalog.product.view'] }, 'name'],
      [{ name: 'Rỗng', permissions: [] }, 'permissions'],
      [{ name: 'Lạ', permissions: ['catalog.product.fly'] }, 'permissions'],
      [{ name: 'Nền tảng', permissions: ['platform.audit.view'] }, 'permissions'],
    ];
    for (const [body, field] of cases) {
      const res = await call('post', '/roles', a.ceo.token, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.body.code).toBe('validation_failed');
      expect(Object.keys(res.body.errors)).toContain(field);
    }
    expect(await roleCount(a.companyId)).toBe(0);
  });

  it('AC-D2a: mã quyền của phân hệ đang tắt → 422 errors.permissions', async () => {
    const { companyId, ceo } = await createCompany({ optionalModules: [] });
    const res = await call('post', '/roles', ceo.token, { name: 'Mua hàng', permissions: ['purchasing.order.manage'] });
    expect(res.status).toBe(422);
    expect(res.body.errors).toHaveProperty('permissions');
    expect(await roleCount(companyId)).toBe(0);
  });

  it('AC-12, D3: tên trùng (không phân biệt hoa thường, kể cả tên vai trò có sẵn) → 409; công ty khác cùng tên → 201', async () => {
    const a = await companyWithAdmin();
    await createRole(a.admin.token, 'Nhân viên kho tạm', ['catalog.product.view']);
    for (const name of ['Nhân viên kho tạm', 'nhân viên KHO tạm', 'sale', 'ADMIN', 'nhân viên KHO']) {
      const res = await call('post', '/roles', a.admin.token, { name, permissions: ['catalog.product.view'] });
      expect(res.status, name).toBe(409);
      expect(res.body.code).toBe('role_name_taken');
      expect(res.body.errors).toHaveProperty('name');
    }
    const b = await companyWithAdmin();
    await createRole(b.admin.token, 'Nhân viên kho tạm', ['catalog.product.view']);
  });

  it('AC-13: Admin tạo vai trò có quyền mình không có → 403 permission_not_held', async () => {
    const a = await companyWithAdmin();
    const res = await call('post', '/roles', a.admin.token, { name: 'Kế toán kho', permissions: ['inventory.cost.view'] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('permission_not_held');
    expect(await roleCount(a.companyId)).toBe(0);
  });
});

describe('PUT /identity/roles/:id', () => {
  it('AC-18, S-2: sửa 200 trả bản ghi mới, version tăng, nhật ký update có before/after', async () => {
    const a = await companyWithAdmin();
    const role = await createRole(a.admin.token, 'Thu ngân', ['sales.order.view']);
    const res = await call('put', `/roles/${role.id}`, a.admin.token, {
      name: 'Thu ngân ca tối',
      permissions: ['sales.order.view', 'payment.link.create'],
      version: 1,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: role.id,
      name: 'Thu ngân ca tối',
      version: 2,
      permissions: ['payment.link.create', 'sales.order.view'],
    });
    expect((await roleRow(role.id))?.permissions).toEqual(['payment.link.create', 'sales.order.view']);
    const logs = await auditOf(role.id);
    expect(logs[1]).toMatchObject({
      action: 'update',
      before: { name: 'Thu ngân', permissions: ['sales.order.view'] },
      after: { name: 'Thu ngân ca tối', permissions: ['payment.link.create', 'sales.order.view'] },
    });
  });

  it('AC-11, AC-12: PUT thiếu version → 422 errors.version; đổi tên trùng vai trò khác → 409', async () => {
    const a = await companyWithAdmin();
    const r1 = await createRole(a.admin.token, 'Vai trò một', ['sales.order.view']);
    await createRole(a.admin.token, 'Vai trò hai', ['sales.order.view']);
    const noVersion = await call('put', `/roles/${r1.id}`, a.admin.token, { name: 'X', permissions: ['sales.order.view'] });
    expect(noVersion.status).toBe(422);
    expect(noVersion.body.errors).toHaveProperty('version');
    const dup = await call('put', `/roles/${r1.id}`, a.admin.token, {
      name: 'VAI TRÒ HAI',
      permissions: ['sales.order.view'],
      version: 1,
    });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('role_name_taken');
    const same = await call('put', `/roles/${r1.id}`, a.admin.token, {
      name: 'vai trò một',
      permissions: ['sales.order.view'],
      version: 1,
    });
    expect(same.status).toBe(200);
    expect(await auditOf(r1.id)).toHaveLength(2);
  });

  it('AC-11: PUT tên hoặc quyền sai → 422 theo ô name / permissions, vai trò không đổi', async () => {
    const a = await companyWithAdmin();
    const role = await createRole(a.admin.token, 'Giữ nguyên', ['sales.order.view']);
    const before = await roleRow(role.id);
    const cases: [object, string][] = [
      [{ permissions: ['sales.order.view'] }, 'name'],
      [{ name: '   ', permissions: ['sales.order.view'] }, 'name'],
      [{ name: 'x'.repeat(61), permissions: ['sales.order.view'] }, 'name'],
      [{ name: 'Rỗng' }, 'permissions'],
      [{ name: 'Rỗng', permissions: [] }, 'permissions'],
      [{ name: 'Lạ', permissions: ['catalog.product.fly'] }, 'permissions'],
      [{ name: 'Nền tảng', permissions: ['platform.audit.view'] }, 'permissions'],
    ];
    for (const [body, field] of cases) {
      const res = await call('put', `/roles/${role.id}`, a.ceo.token, { ...body, version: 1 });
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.body.code).toBe('validation_failed');
      expect(Object.keys(res.body.errors)).toContain(field);
    }
    expect(await roleRow(role.id)).toEqual(before);
    expect(await auditOf(role.id)).toHaveLength(1);
  });

  it('AC-13: Admin thêm quyền mình không có, hoặc sửa/xoá vai trò đang có quyền đó → 403, không đổi', async () => {
    const a = await companyWithAdmin();
    const own = await createRole(a.admin.token, 'Kho cơ bản', ['inventory.stock.view']);
    const add = await call('put', `/roles/${own.id}`, a.admin.token, {
      name: 'Kho cơ bản',
      permissions: ['inventory.stock.view', 'inventory.cost.view'],
      version: 1,
    });
    expect(add.body.code).toBe('permission_not_held');
    const ceoRole = await createRole(a.ceo.token, 'Kế toán', ['inventory.cost.view', 'catalog.product.view']);
    const before = await roleRow(ceoRole.id);
    const edit = await call('put', `/roles/${ceoRole.id}`, a.admin.token, {
      name: 'Kế toán',
      permissions: ['catalog.product.view'],
      version: 1,
    });
    expect(edit.status).toBe(403);
    expect(edit.body.code).toBe('permission_not_held');
    const del = await call('delete', `/roles/${ceoRole.id}?version=1`, a.admin.token);
    expect(del.body.code).toBe('permission_not_held');
    expect(await roleRow(ceoRole.id)).toEqual(before);
    expect(await roleRow(own.id)).toMatchObject({ version: 1, permissions: ['inventory.stock.view'] });
  });

  it('AC-14: PUT/DELETE bốn vai trò có sẵn → 403 builtin_role, vai trò có sẵn không đổi', async () => {
    const { ceo } = await createCompany();
    const before = await Promise.all(BUILTIN_IDS.map(roleRow));
    for (const id of BUILTIN_IDS) {
      const put = await call('put', `/roles/${id}`, ceo.token, { name: 'Đổi', permissions: ['catalog.product.view'], version: 1 });
      expect(put.status).toBe(403);
      expect(put.body.code).toBe('builtin_role');
      const del = await call('delete', `/roles/${id}?version=1`, ceo.token);
      expect(del.body.code).toBe('builtin_role');
    }
    expect(await Promise.all(BUILTIN_IDS.map(roleRow))).toEqual(before);
    for (const role of Object.values(BUILTIN_ROLES)) {
      expect((await roleRow(role.id))?.permissions).toEqual([...role.permissions].sort());
    }
  });

  it('AC-15: version cũ → 409 version_conflict kèm current, không đổi gì', async () => {
    const a = await companyWithAdmin();
    const role = await createRole(a.admin.token, 'Đổi nhiều lần', ['sales.order.view']);
    for (const version of [1, 2]) {
      const res = await call('put', `/roles/${role.id}`, a.admin.token, {
        name: `Lần ${version}`,
        permissions: ['sales.order.view'],
        version,
      });
      expect(res.status).toBe(200);
    }
    const before = await roleRow(role.id);
    expect(before?.version).toBe(3);
    const put = await call('put', `/roles/${role.id}`, a.admin.token, { name: 'Cũ', permissions: ['sales.order.view'], version: 2 });
    expect(put.status).toBe(409);
    expect(put.body.code).toBe('version_conflict');
    expect(put.body.current).toMatchObject({ id: role.id, name: 'Lần 2', version: 3, builtIn: false });
    const del = await call('delete', `/roles/${role.id}?version=2`, a.admin.token);
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('version_conflict');
    expect(await roleRow(role.id)).toEqual(before);
    expect(await auditOf(role.id)).toHaveLength(3);
  });

  it('AC-D2a, AC-D2b: PUT gửi quyền phân hệ tắt → 422; PUT giữ quyền phân hệ tắt mà vai trò đang có', async () => {
    const { companyId, ceo } = await createCompany({ optionalModules: ['purchasing'] });
    const role = await createRole(ceo.token, 'Mua hàng', ['purchasing.order.manage', 'catalog.product.view']);
    await setModuleEnabled(companyId, 'purchasing', false);
    const bad = await call('put', `/roles/${role.id}`, ceo.token, {
      name: 'Mua hàng',
      permissions: ['purchasing.order.approve'],
      version: 1,
    });
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toHaveProperty('permissions');
    const res = await call('put', `/roles/${role.id}`, ceo.token, {
      name: 'Mua hàng (tạm dừng)',
      permissions: ['catalog.product.view'],
      version: 1,
    });
    expect(res.status).toBe(200);
    expect((await roleRow(role.id))?.permissions).toEqual(['catalog.product.view', 'purchasing.order.manage']);
  });

  it('AC-D2b: Admin sửa vai trò đang giữ quyền phân hệ tắt mà Admin không mang → 403 permission_not_held, không đổi', async () => {
    const { companyId, ceo } = await createCompany({ optionalModules: ['purchasing'] });
    const admin = await addMember(companyId, 'admin');
    expect(ADMIN_PERMS).not.toContain('purchasing.order.manage');
    const role = await createRole(ceo.token, 'Mua hàng', ['purchasing.order.manage', 'catalog.product.view']);
    await setModuleEnabled(companyId, 'purchasing', false);
    const before = await roleRow(role.id);
    const res = await call('put', `/roles/${role.id}`, admin.token, {
      name: 'Mua hàng (tạm dừng)',
      permissions: ['catalog.product.view'],
      version: 1,
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('permission_not_held');
    expect(await roleRow(role.id)).toEqual(before);
  });

  it('S-3: bỏ quyền khỏi vai trò tuỳ biến → người mang vai trò bị chặn ngay ở lần gọi kế tiếp (D1)', async () => {
    const a = await companyWithAdmin();
    const role = await createRole(a.admin.token, 'Xem vai trò', ['identity.role.view', 'catalog.product.view']);
    const member = await addMember(a.companyId, role.id);
    expect((await call('get', '/roles', member.token)).status).toBe(200);
    await call('put', `/roles/${role.id}`, a.admin.token, { name: 'Xem vai trò', permissions: ['catalog.product.view'], version: 1 });
    const res = await call('get', '/roles', member.token);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden');
  });
});

// Người khác đang ghi (chưa commit) nên bước kiểm trước khi ghi không thấy; ràng buộc DB chặn, service đổi thành 409.
describe('chạy đua ghi vai trò (#8 plan 7b: 23505, 23503)', () => {
  const insertRole = (companyId: string, name: string) => (holder: PoolClient) =>
    holder.query("insert into access.roles (company_id, name, kind) values ($1, $2, 'custom')", [companyId, name]);

  it('tạo vai trò cùng tên với vai trò đang được ghi → 409 role_name_taken, chỉ một vai trò', async () => {
    const a = await companyWithAdmin();
    const res = await raceBehindLock(insertRole(a.companyId, 'Đua tên'), 1, () =>
      call('post', '/roles', a.admin.token, { name: 'Đua tên', permissions: ['sales.order.view'] }).then((r) => r),
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('role_name_taken');
    expect(res.body.errors).toHaveProperty('name');
    expect(await roleCount(a.companyId)).toBe(1);
  });

  it('đổi tên trùng vai trò đang được ghi → 409 role_name_taken, vai trò không đổi', async () => {
    const a = await companyWithAdmin();
    const role = await createRole(a.admin.token, 'Tên cũ', ['sales.order.view']);
    const before = await roleRow(role.id);
    const res = await raceBehindLock(insertRole(a.companyId, 'Đua tên'), 1, () =>
      call('put', `/roles/${role.id}`, a.admin.token, { name: 'Đua tên', permissions: ['sales.order.view'], version: 1 }).then((r) => r),
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('role_name_taken');
    expect(await roleRow(role.id)).toEqual(before);
  });

  it('xoá vai trò đang được gán cho nhân viên → 409 role_in_use, vai trò còn nguyên', async () => {
    const a = await companyWithAdmin();
    const role = await createRole(a.admin.token, 'Sắp gán', ['sales.order.view']);
    const member = await addMember(a.companyId, 'sale');
    const before = await roleRow(role.id);
    const assign = (holder: PoolClient) =>
      holder.query('insert into access.member_roles (membership_id, role_id, company_id) values ($1, $2, $3)', [
        member.membershipId,
        role.id,
        a.companyId,
      ]);
    const res = await raceBehindLock(assign, 1, () => call('delete', `/roles/${role.id}?version=1`, a.admin.token).then((r) => r));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('role_in_use');
    expect(await roleRow(role.id)).toEqual(before);
  });
});

describe('DELETE /identity/roles/:id', () => {
  it('AC-18: thiếu hoặc sai ?version= → 422 errors.version', async () => {
    const a = await companyWithAdmin();
    const role = await createRole(a.admin.token, 'Sắp xoá', ['sales.order.view']);
    for (const query of ['', '?version=abc']) {
      const res = await call('delete', `/roles/${role.id}${query}`, a.admin.token);
      expect(res.status).toBe(422);
      expect(res.body.errors).toHaveProperty('version');
    }
  });

  it('AC-16: còn người mang → 409 role_in_use; không còn ai → 204, nhật ký delete có before', async () => {
    const a = await companyWithAdmin();
    const role = await createRole(a.admin.token, 'Tạm thời', ['sales.order.view']);
    const member = await addMember(a.companyId, role.id);
    const inUse = await call('delete', `/roles/${role.id}?version=1`, a.admin.token);
    expect(inUse.status).toBe(409);
    expect(inUse.body.code).toBe('role_in_use');
    expect(await roleRow(role.id)).toBeDefined();

    await testPool().query('delete from access.member_roles where membership_id = $1', [member.membershipId]);
    const res = await call('delete', `/roles/${role.id}?version=1`, a.admin.token);
    expect(res.status).toBe(204);
    expect(await roleRow(role.id)).toBeUndefined();
    expect((await call('put', `/roles/${role.id}`, a.admin.token, { name: 'X', permissions: ['sales.order.view'], version: 1 })).status).toBe(404);
    const logs = await auditOf(role.id);
    expect(logs.at(-1)).toMatchObject({
      action: 'delete',
      after: null,
      before: { name: 'Tạm thời', permissions: ['sales.order.view'] },
    });
  });
});

describe('Swagger (S-1)', () => {
  it('có đủ năm operation của vai trò và quyền', async () => {
    const res = await request(testApp()).get('/api/openapi.json');
    const paths = res.body.paths;
    expect(Object.keys(paths[`${API}/permissions`] ?? {})).toEqual(['get']);
    expect(Object.keys(paths[`${API}/roles`] ?? {}).sort()).toEqual(['get', 'post']);
    expect(Object.keys(paths[`${API}/roles/{id}`] ?? {}).sort()).toEqual(['delete', 'put']);
    expect(paths[`${API}/roles/{id}`].put.responses['409'].content).toHaveProperty('application/problem+json');
  });
});

