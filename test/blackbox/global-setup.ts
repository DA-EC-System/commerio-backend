import type { TestProject } from 'vitest/node';
import { ACCOUNTS, api, BASE_URL, call, declaredRoutes, PASSWORD, type Role, signIn } from './lib/client.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    tokens: Record<Role, string>;
    companies: { a: string; b: string };
    /** `METHOD /api/v1/...` server khai; `null` khi tắt tài liệu API (chạy mọi file). */
    routes: string[] | null;
  }
}

/**
 * Vai trò tuỳ biến vừa lập vừa duyệt (đề nghị nhập, cấu hình tiền), để kiểm ca người thứ hai bằng người không phải CEO
 * (Documents/26 §3.1, ca `p`).
 */
const LEAD_ROLE = {
  name: 'QA Lập và duyệt',
  permissions: ['purchasing.request.manage', 'purchasing.request.approve', 'finance.config.manage', 'finance.config.approve'],
};

/** Gắn vai trò tuỳ biến cho `qa-truong-mua` (giữ vai trò Mua hàng của seed). Chạy lại không đổi gì. */
async function prepareLead(ceo: string) {
  const roles = await api(ceo).get('/identity/roles');
  type RoleRow = { id: string; name: string; permissions: string[]; version: number };
  let role = (roles.body as RoleRow[]).find((r) => r.name === LEAD_ROLE.name);
  if (!role) {
    const created = await api(ceo).post('/identity/roles', LEAD_ROLE);
    if (created.status !== 201) throw new Error(`Tạo vai trò ${LEAD_ROLE.name}: ${created.status} ${JSON.stringify(created.body)}`);
    role = created.body as RoleRow;
  } else if ([...role.permissions].sort().join() !== [...LEAD_ROLE.permissions].sort().join()) {
    const updated = await api(ceo).put(`/identity/roles/${role.id}`, { ...LEAD_ROLE, version: role.version });
    if (updated.status !== 200) throw new Error(`Sửa vai trò ${LEAD_ROLE.name}: ${updated.status} ${JSON.stringify(updated.body)}`);
  }
  const staff = await api(ceo).get(`/identity/staff?search=${encodeURIComponent(ACCOUNTS.lead)}`);
  const lead = staff.body.items?.[0] as { accountId: string; roles: { id: string }[]; version: number } | undefined;
  if (!lead) throw new Error(`Không thấy ${ACCOUNTS.lead} trong công ty A: chạy npm run db:seed`);
  if (lead.roles.some((r) => r.id === role!.id)) return;
  const roleIds = [...lead.roles.map((r) => r.id), role!.id];
  const changed = await api(ceo).put(`/identity/staff/${lead.accountId}/roles`, { roleIds, version: lead.version });
  if (changed.status !== 200) throw new Error(`Gắn vai trò cho ${ACCOUNTS.lead}: ${changed.status} ${JSON.stringify(changed.body)}`);
}

/** Đăng nhập mỗi tài khoản một lần cho cả lượt (giới hạn đăng nhập theo IP của server), chia token cho các file. */
export default async function setup(project: TestProject) {
  if (!BASE_URL || !PASSWORD) throw new Error('Cần BLACKBOX_BASE_URL và BLACKBOX_PASSWORD (mật khẩu seed của server đó)');
  // Staging chỉ đưa /api/* tới api (Caddy), nên hỏi một route API thay cho /health.
  const probe = await call('GET', '/identity/me').catch((err: unknown) => {
    throw new Error(`Không gọi được ${BASE_URL}/api/v1: ${String(err)}`);
  });
  if (probe.status !== 401) throw new Error(`${BASE_URL}/api/v1/identity/me không token trả ${probe.status}, không phải api Commerio`);

  const tokens = {} as Record<Role, string>;
  const companyOf = {} as Record<Role, string>;
  for (const role of Object.keys(ACCOUNTS) as Role[]) {
    const { token, companyId } = await signIn(ACCOUNTS[role]);
    tokens[role] = token;
    companyOf[role] = companyId;
  }
  if (companyOf.ceo === companyOf.ceoB) throw new Error('qa-ceo và qa-ceo-b phải ở hai công ty khác nhau');
  await prepareLead(tokens.ceo);

  project.provide('tokens', tokens);
  project.provide('companies', { a: companyOf.ceo, b: companyOf.ceoB });
  project.provide('routes', await declaredRoutes());
}
