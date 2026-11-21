// Xoá trọn công ty thử của e2e (Documents/21 mục 2.2). Chạy ngoài `withCompany` (role chủ bảng): bảng
// sổ cái, nhật ký, outbox thu quyền xoá của `commerio_app`. Mọi hàm đi chung giao dịch đang mở.
import { sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';

type Row = Record<string, unknown>;
const rows = async <T extends Row>(query: ReturnType<typeof sql>) => (await getDb().execute<T>(query)).rows;

/** Phần sau `@` của email, chữ thường; so nguyên phần này với miền thử như `isTestEmail` của identity. */
const domainOf = (column: string) => sql.raw(`lower(split_part(${column}, '@', 2))`);

/** Khoá dòng công ty tới hết giao dịch; `undefined` khi không có. */
export async function lockCompany(companyId: string): Promise<{ id: string; name: string; createdAt: Date } | undefined> {
  const [row] = await rows<{ id: string; name: string; created_at: Date }>(
    sql`select id, name, created_at from core.companies where id = ${companyId} for update`,
  );
  return row && { id: row.id, name: row.name, createdAt: new Date(row.created_at) };
}

export interface TestCompanyFacts {
  /** Mọi membership, kể cả đã khoá */
  members: number;
  /** Thành viên có email ngoài miền thử */
  outsideMembers: number;
  /** Thành viên là quản trị nền tảng: không bao giờ coi là công ty thử */
  platformAdmins: number;
  /** Lời mời đang chờ (`open`, `claimed`, `pending`) có email ngoài miền thử */
  outsideInvitations: number;
}

/** Số liệu để quyết công ty có phải công ty thử không (mọi người liên quan đều thuộc miền thử, không ai là quản trị nền tảng). */
export async function testCompanyFacts(companyId: string, testDomain: string): Promise<TestCompanyFacts> {
  const [row] = await rows<{ members: string; outside_members: string; platform_admins: string; outside_invitations: string }>(sql`
    select
      (select count(*) from core.memberships m where m.company_id = ${companyId}) as members,
      (select count(*) from core.memberships m join core.accounts a on a.id = m.account_id
        where m.company_id = ${companyId} and ${domainOf('a.email')} is distinct from ${testDomain}) as outside_members,
      (select count(*) from core.memberships m join core.accounts a on a.id = m.account_id
        where m.company_id = ${companyId} and a.is_platform_admin) as platform_admins,
      (select count(*) from core.invitations i
        where i.company_id = ${companyId} and i.status in ('open', 'claimed', 'pending') and i.email is not null
          and ${domainOf('i.email')} is distinct from ${testDomain}) as outside_invitations`);
  return {
    members: Number(row!.members),
    outsideMembers: Number(row!.outside_members),
    platformAdmins: Number(row!.platform_admins),
    outsideInvitations: Number(row!.outside_invitations),
  };
}

/** Người gọi có membership đang hoạt động với vai trò CEO ở công ty này không. */
export async function isActiveCeo(companyId: string, accountId: string, ceoRoleId: string): Promise<boolean> {
  const found = await rows(sql`
    select 1 from core.memberships m
    join core.member_roles r on r.membership_id = m.id and r.company_id = m.company_id
    where m.company_id = ${companyId} and m.account_id = ${accountId} and m.status = 'active' and r.role_id = ${ceoRoleId}
    limit 1`);
  return found.length > 0;
}

/** Tài khoản dính tới công ty (thành viên, người được mời, người tạo, người duyệt lời mời), lấy trước khi xoá. */
export async function companyAccountIds(companyId: string): Promise<string[]> {
  const found = await rows<{ id: string }>(sql`
    select account_id as id from core.memberships where company_id = ${companyId}
    union select account_id from core.invitations where company_id = ${companyId} and account_id is not null
    union select created_by from core.invitations where company_id = ${companyId}
    union select decided_by from core.invitations where company_id = ${companyId} and decided_by is not null`);
  return found.map((r) => r.id);
}

/**
 * Bảng có cột `company_id` (trừ pg-boss), xếp bảng con trước bảng cha theo khoá ngoại để xoá không vướng: khoá ngoại của
 * app không `DEFERRABLE`. Đọc từ catalog mỗi lần nên bảng mới tự được dọn, không phải sửa danh sách tay.
 */
export async function companyTablesChildFirst(): Promise<string[]> {
  const tables = await rows<{ oid: number; name: string }>(sql`
    select c.oid::int as oid, format('%I.%I', n.nspname, c.relname) as name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'company_id' and not a.attisdropped
    where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema', 'pgboss')
      and not c.relispartition`);
  const edges = await rows<{ child: number; parent: number }>(sql`
    select conrelid::int as child, confrelid::int as parent from pg_constraint
    where contype = 'f' and conrelid <> confrelid`);
  return childFirst(
    tables.map((t) => ({ id: t.oid, name: t.name })),
    edges,
  );
}

/** Kahn trên đồ thị con → cha: bảng không còn bảng con nào chưa xoá thì xoá trước. Có vòng thì ném (không đoán thứ tự). */
export function childFirst(tables: { id: number; name: string }[], edges: { child: number; parent: number }[]): string[] {
  const ids = new Set(tables.map((t) => t.id));
  const children = new Map<number, Set<number>>(tables.map((t) => [t.id, new Set()]));
  for (const e of edges) if (ids.has(e.child) && ids.has(e.parent)) children.get(e.parent)!.add(e.child);
  const name = new Map(tables.map((t) => [t.id, t.name]));
  const out: string[] = [];
  const done = new Set<number>();
  while (done.size < ids.size) {
    const ready = [...ids].filter((id) => !done.has(id) && [...children.get(id)!].every((c) => done.has(c)));
    if (!ready.length) {
      const left = [...ids].filter((id) => !done.has(id)).map((id) => name.get(id));
      throw new Error(`Khoá ngoại vòng giữa các bảng có company_id: ${left.join(', ')}`);
    }
    ready.sort((a, b) => name.get(a)!.localeCompare(name.get(b)!));
    for (const id of ready) {
      done.add(id);
      out.push(name.get(id)!);
    }
  }
  return out;
}

/** Xoá mọi dòng của công ty theo thứ tự đã xếp, rồi dòng công ty và nhật ký tạo công ty (`company_id` trống). */
export async function purgeCompanyRows(companyId: string, tables: readonly string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    // Tên bảng lấy từ catalog qua `format('%I.%I')` nên đã được trích dẫn
    const res = await getDb().execute(sql`delete from ${sql.raw(table)} where company_id = ${companyId}`);
    if (res.rowCount) counts[table] = res.rowCount;
  }
  await getDb().execute(sql`
    delete from core.audit_logs where company_id is null and entity_type = 'core.companies' and entity_id = ${companyId}`);
  const res = await getDb().execute(sql`delete from core.companies where id = ${companyId}`);
  counts['core.companies'] = res.rowCount ?? 0;
  return counts;
}

/**
 * Xoá tài khoản miền thử không còn dính công ty nào (membership, lời mời) và không phải quản trị nền tảng; tài khoản còn
 * ở công ty khác thì giữ. Trả số tài khoản đã xoá
 */
export async function purgeOrphanTestAccounts(accountIds: readonly string[], testDomain: string): Promise<number> {
  if (!accountIds.length) return 0;
  const ids = sql`array[${sql.join(accountIds.map((id) => sql`${id}::uuid`), sql`, `)}]`;
  const orphan = sql`
    select a.id from core.accounts a
    where a.id = any(${ids}) and not a.is_platform_admin and ${domainOf('a.email')} = ${testDomain}
      and not exists (select 1 from core.memberships m where m.account_id = a.id)
      and not exists (select 1 from core.invitations i where i.account_id = a.id or i.created_by = a.id or i.decided_by = a.id)`;
  await getDb().execute(sql`delete from core.refresh_tokens where account_id in (${orphan})`);
  const res = await getDb().execute(sql`delete from core.accounts where id in (${orphan})`);
  return res.rowCount ?? 0;
}

/** Công ty tạo trước `before` mà mọi thành viên thuộc miền thử, không ai là quản trị nền tảng (ứng viên của việc nền). */
export async function staleTestCompanyIds(before: Date, testDomain: string): Promise<string[]> {
  const found = await rows<{ id: string }>(sql`
    select c.id from core.companies c
    where c.created_at < ${before.toISOString()}::timestamptz
      and exists (select 1 from core.memberships m where m.company_id = c.id)
      and not exists (
        select 1 from core.memberships m join core.accounts a on a.id = m.account_id
        where m.company_id = c.id and (a.is_platform_admin or ${domainOf('a.email')} is distinct from ${testDomain}))
    order by c.created_at`);
  return found.map((r) => r.id);
}
