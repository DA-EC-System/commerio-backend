import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { expect } from 'vitest';
import { BUILTIN_ROLES } from '#src/modules/core/access/domain/catalog.ts';
import { registrationOtpHash } from '#src/modules/core/identity/domain/registration.ts';
import { hashPassword } from '#src/modules/core/identity/service/passwords.ts';
import { OPTIONAL_MODULES, type OptionalModule } from '#src/modules/core/platform/domain/modules.ts';
import { testPool } from './db.ts';
import { login, PASSWORD, selectCompany, testApp } from './http.ts';

export const uniqueEmail = (prefix = 'ceo') => `${prefix}-${randomUUID()}@test.vn`;

/** Mã số thuế 10 số chưa công ty nào dùng (CSDL ép unique, #459). */
export const uniqueTaxCode = () => String(Math.floor(Math.random() * 1e10)).padStart(10, '0');

export function registerBody(email: string, overrides: Record<string, unknown> = {}) {
  return {
    company: { name: 'Công ty Thử Nghiệm', taxCode: uniqueTaxCode() },
    ceo: { fullName: 'Nguyễn Văn Thử', email, password: PASSWORD },
    ...overrides,
  };
}

/** Đặt đúng bộ phân hệ tuỳ chọn đang bật (đăng ký chỉ bật sẵn Nhập hàng, #459). */
async function setOptionalModules(companyId: string, enabled: readonly OptionalModule[]) {
  for (const code of OPTIONAL_MODULES) {
    await testPool().query(
      `insert into core.company_modules (company_id, module_code, enabled) values ($1, $2, $3)
       on conflict (company_id, module_code) do update set enabled = excluded.enabled`,
      [companyId, code, enabled.includes(code)],
    );
  }
}

/** Mã helper ghi thẳng bản băm vào DB thay cho thư (test không chạy worker gửi thư). */
export const KNOWN_REGISTRATION_CODE = '135790';

/** Gửi form đăng ký (202) rồi đặt mã biết trước cho lần đăng ký đó; trả `registrationId`. */
export async function startRegistration(email = uniqueEmail(), overrides: Record<string, unknown> = {}) {
  const res = await request(testApp()).post('/api/v1/identity/register').send(registerBody(email, overrides));
  expect(res.status).toBe(202);
  const registrationId = res.body.registrationId as string;
  await testPool().query('update core.registrations set otp_hash = $2 where id = $1', [
    registrationId,
    registrationOtpHash(KNOWN_REGISTRATION_CODE, registrationId),
  ]);
  return registrationId;
}

/** Đăng ký công ty qua API (UC-PI-01, hai bước #459): gửi form, nhập mã; trả phiên đã gắn công ty mới. */
export async function registerCompany(email = uniqueEmail(), overrides: Record<string, unknown> = {}) {
  const registrationId = await startRegistration(email, overrides);
  const res = await request(testApp())
    .post('/api/v1/identity/register/verify')
    .send({ registrationId, code: KNOWN_REGISTRATION_CODE });
  expect(res.status).toBe(201);
  return { email, companyId: res.body.context.companyId as string, accessToken: res.body.accessToken as string };
}

/** Công ty mới qua API, kèm token đã chọn công ty của CEO. Phân hệ tuỳ chọn mặc định `purchasing`, `report`. */
export async function createCompany(options: { optionalModules?: OptionalModule[] } = {}) {
  const { email, companyId } = await registerCompany(uniqueEmail());
  await setOptionalModules(companyId, options.optionalModules ?? ['purchasing', 'report']);
  const { token } = await login(email);
  return { companyId, ceo: { email, token: await selectCompany(token, companyId) } };
}

const ROLE_IDS = { admin: BUILTIN_ROLES.admin.id, sale: BUILTIN_ROLES.sale.id, warehouse: BUILTIN_ROLES.kho.id };

/**
 * Thêm nhân viên bằng SQL (API mời nhân viên là #7, chưa có), rồi đăng nhập và chọn công ty như người thật.
 * `role`: vai trò có sẵn (`admin`, `sale`, `warehouse`) hoặc id vai trò tuỳ biến của công ty.
 */
export async function addMember(companyId: string, role: keyof typeof ROLE_IDS | (string & {})) {
  const db = testPool();
  const email = uniqueEmail('nv');
  const account = await db.query<{ id: string }>(
    'insert into core.accounts (email, full_name, password_hash) values ($1, $2, $3) returning id',
    [email, 'Nhân Viên Thử', await hashPassword(PASSWORD)],
  );
  const accountId = account.rows[0]!.id;
  const membership = await db.query<{ id: string }>(
    'insert into core.memberships (company_id, account_id) values ($1, $2) returning id',
    [companyId, accountId],
  );
  const membershipId = membership.rows[0]!.id;
  const roleId = role in ROLE_IDS ? ROLE_IDS[role as keyof typeof ROLE_IDS] : role;
  await db.query('insert into core.member_roles (membership_id, role_id, company_id) values ($1, $2, $3)', [
    membershipId,
    roleId,
    companyId,
  ]);
  const { token } = await login(email);
  return { accountId, membershipId, email, token: await selectCompany(token, companyId) };
}

/** Vai trò tuỳ biến với các quyền cho trước, trả id. Test đổi quyền dùng vai trò này, không đụng vai trò có sẵn. */
export async function createCustomRole(companyId: string, permissions: readonly string[]): Promise<string> {
  const db = testPool();
  const role = await db.query<{ id: string }>(
    "insert into core.roles (company_id, name, kind) values ($1, $2, 'custom') returning id",
    [companyId, `Vai trò ${randomUUID()}`],
  );
  const roleId = role.rows[0]!.id;
  for (const code of permissions) {
    await db.query('insert into core.role_permissions (role_id, permission_code) values ($1, $2)', [roleId, code]);
  }
  return roleId;
}
