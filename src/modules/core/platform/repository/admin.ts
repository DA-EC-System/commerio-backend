// Truy vấn của quản trị nền tảng (#152, UC-PI-08): chạy ngoài `withCompany` bằng role chủ bảng, đọc mọi công ty.
// Join `core.audit_logs` (audit) và `core.accounts` (staff) cùng schema `core` (luật 2 của backend/CLAUDE.md):
// người đăng ký là CEO, lấy từ dòng nhật ký `create core.companies` lúc đăng ký.
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { OPTIONAL_MODULES } from '../domain/modules.ts';
import { companies } from './schema.ts';

/** Chuỗi tìm cho `ILIKE … ESCAPE '\'`: `\`, `%`, `_` của người dùng là ký tự thường. */
const containsPattern = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const OPTIONAL = sql`array[${sql.join(
  OPTIONAL_MODULES.map((m) => sql`${m}`),
  sql`, `,
)}]::text[]`;

export interface CompanyAdminRow {
  id: string;
  name: string;
  tax_code: string;
  status: 'active' | 'locked';
  lock_reason: string | null;
  locked_at: Date | null;
  created_at: Date;
  version: number;
  ceo_name: string | null;
  ceo_email: string | null;
  optional_modules: string[];
  total: string;
}

const COMPANY_SELECT = sql`
  select c.id, c.name, c.tax_code, c.status, c.lock_reason, c.locked_at, c.created_at, c.version,
    acc.full_name as ceo_name, coalesce(reg.after->>'ceoEmail', acc.email) as ceo_email,
    coalesce((select array_agg(m.module_code::text order by array_position(${OPTIONAL}, m.module_code::text))
              from core.company_modules m
              where m.company_id = c.id and m.enabled and m.module_code::text = any(${OPTIONAL})), '{}') as optional_modules,
    count(*) over () as total
  from core.companies c
  left join lateral (
    select a.actor_id, a.after from core.audit_logs a
    where a.company_id is null and a.entity_type = 'core.companies' and a.action = 'create' and a.entity_id = c.id
    order by a.id limit 1
  ) reg on true
  left join core.accounts acc on acc.id = reg.actor_id`;

export async function listCompaniesAdmin(
  f: { search?: string | undefined; status?: 'active' | 'locked' | undefined },
  page: { limit: number; offset: number },
): Promise<{ rows: CompanyAdminRow[]; total: number }> {
  const pattern = f.search ? containsPattern(f.search) : null;
  const { rows } = await getDb().execute<CompanyAdminRow & Record<string, unknown>>(sql`
    ${COMPANY_SELECT}
    where (${pattern}::text is null
           or c.name ilike ${pattern} escape '\\' or c.tax_code ilike ${pattern} escape '\\'
           or coalesce(reg.after->>'ceoEmail', acc.email) ilike ${pattern} escape '\\')
      and (${f.status ?? null}::core.company_status is null or c.status = ${f.status ?? null}::core.company_status)
    order by c.created_at desc, c.id
    limit ${page.limit} offset ${page.offset}`);
  return { rows, total: rows.length > 0 ? Number(rows[0]!.total) : 0 };
}

export async function findCompanyAdmin(id: string): Promise<CompanyAdminRow | undefined> {
  const { rows } = await getDb().execute<CompanyAdminRow & Record<string, unknown>>(sql`${COMPANY_SELECT} where c.id = ${id}`);
  return rows[0];
}

/** Khoá hay mở khoá theo `version`, chỉ khi đang ở trạng thái ngược lại; `false` khi không trúng dòng. */
export async function setCompanyStatus(
  id: string,
  version: number,
  next: { status: 'active' | 'locked'; lockReason: string | null },
): Promise<boolean> {
  const rows = await getDb()
    .update(companies)
    .set({
      status: next.status,
      lockReason: next.lockReason,
      lockedAt: next.status === 'locked' ? new Date() : null,
      updatedAt: new Date(),
      version: sql`${companies.version} + 1`,
    })
    .where(
      and(eq(companies.id, id), eq(companies.version, version), eq(companies.status, next.status === 'locked' ? 'active' : 'locked')),
    )
    .returning({ id: companies.id });
  return rows.length === 1;
}

export async function companyCounts() {
  const { rows } = await getDb().execute<{ total: number; active: number; locked: number; recent: number }>(sql`
    select count(*)::int as total,
      count(*) filter (where status = 'active')::int as active,
      count(*) filter (where status = 'locked')::int as locked,
      count(*) filter (where created_at >= now() - interval '30 days')::int as recent
    from core.companies`);
  return rows[0]!;
}

export async function moduleUsage(): Promise<Map<string, number>> {
  const { rows } = await getDb().execute<{ module: string; companies: number }>(sql`
    select module_code::text as module, count(*)::int as companies from core.company_modules
    where enabled and module_code::text = any(${OPTIONAL}) group by module_code`);
  return new Map(rows.map((r) => [r.module, r.companies]));
}

export interface PlatformAuditRow {
  id: string;
  action: 'create' | 'update';
  company_id: string;
  company_name: string;
  actor_email: string | null;
  after: Record<string, unknown> | null;
  created_at: Date;
  total: string;
}

/** `company.*` của trang nhật ký nền tảng ứng với điều kiện trên dòng `core.companies`. */
const ACTION_SQL = {
  'company.registered': sql`a.action = 'create'`,
  'company.locked': sql`a.action = 'update' and a.after->>'status' = 'locked'`,
  'company.unlocked': sql`a.action = 'update' and a.after->>'status' = 'active'`,
} as const;
export type PlatformAuditAction = keyof typeof ACTION_SQL;

export async function listPlatformAudit(
  f: { action?: PlatformAuditAction | undefined; search?: string | undefined; from?: Date | undefined; to?: Date | undefined },
  page: { limit: number; offset: number },
): Promise<{ rows: PlatformAuditRow[]; total: number }> {
  const pattern = f.search ? containsPattern(f.search) : null;
  const action = f.action ? ACTION_SQL[f.action] : sql`(${sql.join(Object.values(ACTION_SQL), sql` or `)})`;
  const { rows } = await getDb().execute<PlatformAuditRow & Record<string, unknown>>(sql`
    select a.id::text as id, a.action, c.id as company_id, c.name as company_name, acc.email as actor_email,
      a.after, a.created_at, count(*) over () as total
    from core.audit_logs a
    join core.companies c on c.id = a.entity_id
    left join core.accounts acc on acc.id = a.actor_id
    where a.company_id is null and a.entity_type = 'core.companies' and ${action}
      and (${pattern}::text is null or c.name ilike ${pattern} escape '\\' or acc.email ilike ${pattern} escape '\\')
      and (${f.from ?? null}::timestamptz is null or a.created_at >= ${f.from ?? null}::timestamptz)
      and (${f.to ?? null}::timestamptz is null or a.created_at < ${f.to ?? null}::timestamptz)
    order by a.id desc
    limit ${page.limit} offset ${page.offset}`);
  return { rows, total: rows.length > 0 ? Number(rows[0]!.total) : 0 };
}
