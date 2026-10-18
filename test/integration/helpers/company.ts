import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { expect } from 'vitest';
import { BUILTIN_ROLES } from '#src/modules/access/domain/catalog.ts';
import { hashPassword } from '#src/modules/identity/service/passwords.ts';
import type { OptionalModule } from '#src/modules/platform/domain/modules.ts';
import { testPool } from './db.ts';
import { login, PASSWORD, selectCompany, testApp } from './http.ts';

export const uniqueEmail = (prefix = 'ceo') => `${prefix}-${randomUUID()}@test.vn`;

export function registerBody(email: string, overrides: Record<string, unknown> = {}) {
  return {
    company: { name: 'Công ty Thử Nghiệm', taxCode: '0312345678' },
    ceo: { fullName: 'Nguyễn Văn Thử', email, password: PASSWORD },
    optionalModules: ['purchasing', 'report'],
    assistantDataConsent: false,
    ...overrides,
  };
}

/** Đăng ký công ty qua API (UC-PI-01); chưa đăng nhập. */
export async function registerCompany(email = uniqueEmail(), overrides: Record<string, unknown> = {}) {
  const res = await request(testApp()).post('/api/v1/identity/register').send(registerBody(email, overrides));
  expect(res.status).toBe(201);
  return { email, companyId: res.body.companyId as string };
}

/** Công ty mới qua API, kèm token đã chọn công ty của CEO. Mặc định bật thêm `purchasing`, `report`. */
export async function createCompany(options: { optionalModules?: OptionalModule[] } = {}) {
  const overrides = options.optionalModules ? { optionalModules: options.optionalModules } : {};
  const { email, companyId } = await registerCompany(uniqueEmail(), overrides);
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
    'insert into staff.accounts (email, full_name, password_hash) values ($1, $2, $3) returning id',
    [email, 'Nhân Viên Thử', await hashPassword(PASSWORD)],
  );
  const accountId = account.rows[0]!.id;
  const membership = await db.query<{ id: string }>(
    'insert into staff.memberships (company_id, account_id) values ($1, $2) returning id',
    [companyId, accountId],
  );
  const membershipId = membership.rows[0]!.id;
  const roleId = role in ROLE_IDS ? ROLE_IDS[role as keyof typeof ROLE_IDS] : role;
  await db.query('insert into access.member_roles (membership_id, role_id, company_id) values ($1, $2, $3)', [
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
    "insert into access.roles (company_id, name, kind) values ($1, $2, 'custom') returning id",
    [companyId, `Vai trò ${randomUUID()}`],
  );
  const roleId = role.rows[0]!.id;
  for (const code of permissions) {
    await db.query('insert into access.role_permissions (role_id, permission_code) values ($1, $2)', [roleId, code]);
  }
  return roleId;
}
