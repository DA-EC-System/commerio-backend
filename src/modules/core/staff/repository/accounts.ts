import { and, count, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import { getDb, requireCompanyId } from '../../../../shared/db/client.ts';
import { accounts, memberships } from './schema.ts';

export interface AccountRow {
  id: string;
  email: string;
  fullName: string;
  passwordHash: string | null;
  mustChangePassword: boolean;
  isPlatformAdmin: boolean;
  passwordChangedAt: Date | null;
  /** `sub` của tài khoản Google đã liên kết (#7 [A]); `null` khi chưa liên kết. */
  googleSub: string | null;
}

export interface MembershipRow {
  id: string;
  companyId: string;
  status: 'active' | 'suspended';
}

const accountColumns = {
  id: accounts.id,
  email: accounts.email,
  fullName: accounts.fullName,
  passwordHash: accounts.passwordHash,
  mustChangePassword: accounts.mustChangePassword,
  isPlatformAdmin: accounts.isPlatformAdmin,
  passwordChangedAt: accounts.passwordChangedAt,
  googleSub: accounts.googleSub,
};

export async function findAccountByEmail(email: string): Promise<AccountRow | undefined> {
  const [row] = await getDb().select(accountColumns).from(accounts).where(eq(accounts.email, email));
  return row;
}

export async function findAccountById(id: string): Promise<AccountRow | undefined> {
  const [row] = await getDb().select(accountColumns).from(accounts).where(eq(accounts.id, id));
  return row;
}

export async function findAccountByGoogleSub(sub: string): Promise<AccountRow | undefined> {
  const [row] = await getDb().select(accountColumns).from(accounts).where(eq(accounts.googleSub, sub));
  return row;
}

/**
 * Liên kết Google lần đầu: chỉ ghi khi tài khoản chưa gắn `sub` nào, `true` khi ghi được. Hai request liên kết
 * cùng lúc thì request sau chờ khoá dòng rồi không trúng dòng. Chạy ngoài `withCompany` (migration 0017:
 * `commerio_app` không được UPDATE `core.accounts`). `sub` đã gắn tài khoản khác thì ném 23505
 * `accounts_google_sub_unique`.
 */
export async function linkGoogleSub(accountId: string, sub: string): Promise<boolean> {
  const rows = await getDb()
    .update(accounts)
    .set({ googleSub: sub, updatedAt: new Date(), version: sql`${accounts.version} + 1` })
    .where(and(eq(accounts.id, accountId), isNull(accounts.googleSub)))
    .returning({ id: accounts.id });
  return rows.length === 1;
}

/** Họ tên, email và lúc tạo của các tài khoản (người tạo link, người thao tác trong nhật ký); id không có thì bỏ. */
export async function findAccountSummaries(
  ids: readonly string[],
): Promise<{ id: string; email: string; fullName: string; createdAt: Date }[]> {
  if (ids.length === 0) return [];
  return getDb()
    .select({ id: accounts.id, email: accounts.email, fullName: accounts.fullName, createdAt: accounts.createdAt })
    .from(accounts)
    .where(inArray(accounts.id, [...new Set(ids)]));
}

export async function insertAccount(input: { email: string; fullName: string; passwordHash: string }): Promise<string> {
  const [row] = await getDb().insert(accounts).values(input).returning({ id: accounts.id });
  return row!.id;
}

export async function updatePassword(id: string, passwordHash: string): Promise<void> {
  await getDb()
    .update(accounts)
    .set({
      passwordHash,
      mustChangePassword: false,
      passwordChangedAt: new Date(),
      updatedAt: new Date(),
      version: sql`${accounts.version} + 1`,
    })
    .where(eq(accounts.id, id));
}

export async function insertMembership(companyId: string, accountId: string): Promise<string> {
  const [row] = await getDb().insert(memberships).values({ companyId, accountId }).returning({ id: memberships.id });
  return row!.id;
}

export async function membershipsOfAccount(accountId: string): Promise<MembershipRow[]> {
  return getDb()
    .select({ id: memberships.id, companyId: memberships.companyId, status: memberships.status })
    .from(memberships)
    .where(eq(memberships.accountId, accountId))
    .orderBy(memberships.createdAt);
}

/** Membership kèm `passwordChangedAt` của tài khoản (join cùng schema), để `authorize` so dấu token không tốn thêm truy vấn. */
export async function findMembership(
  accountId: string,
  companyId: string,
): Promise<(MembershipRow & { passwordChangedAt: Date | null }) | undefined> {
  const [row] = await getDb()
    .select({
      id: memberships.id,
      companyId: memberships.companyId,
      status: memberships.status,
      passwordChangedAt: accounts.passwordChangedAt,
    })
    .from(memberships)
    .innerJoin(accounts, eq(accounts.id, memberships.accountId))
    .where(and(eq(memberships.accountId, accountId), eq(memberships.companyId, companyId)));
  return row;
}

// Nhân viên trong công ty (#7 [B]). Các hàm dưới chạy trong withCompany: RLS của memberships chỉ cho thấy công ty
// đang chọn; vẫn lọc thêm `company_id` cho rõ.

export interface MemberRow {
  membershipId: string;
  accountId: string;
  email: string;
  fullName: string;
  status: 'active' | 'suspended';
  mustChangePassword: boolean;
  joinedAt: Date;
  version: number;
}

export interface StaffQuery {
  search?: string;
  status?: 'active' | 'locked';
  page: number;
  pageSize: number;
}

const memberColumns = {
  membershipId: memberships.id,
  accountId: accounts.id,
  email: accounts.email,
  fullName: accounts.fullName,
  status: memberships.status,
  mustChangePassword: accounts.mustChangePassword,
  joinedAt: memberships.createdAt,
  version: memberships.version,
};

export async function findMemberByAccount(accountId: string): Promise<MemberRow | undefined> {
  const companyId = requireCompanyId('findMemberByAccount');
  const [row] = await getDb()
    .select(memberColumns)
    .from(memberships)
    .innerJoin(accounts, eq(accounts.id, memberships.accountId))
    .where(and(eq(memberships.companyId, companyId), eq(memberships.accountId, accountId)));
  return row;
}

/** Số thành viên đang hoạt động của công ty hiện tại. */
export async function countActiveMembers(): Promise<number> {
  const companyId = requireCompanyId('countActiveMembers');
  const [row] = await getDb()
    .select({ n: count() })
    .from(memberships)
    .where(and(eq(memberships.companyId, companyId), eq(memberships.status, 'active')));
  return row!.n;
}

/** Chuỗi tìm cho `ILIKE … ESCAPE '\'`: `\`, `%`, `_` của người dùng là ký tự thường, không phải ký tự đại diện. */
const containsPattern = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** `membershipIds` (lọc theo vai trò, bên gọi lấy từ access) rỗng thì không có ai. */
export async function listMembers(
  query: StaffQuery & { membershipIds?: readonly string[] },
): Promise<{ rows: MemberRow[]; total: number }> {
  const companyId = requireCompanyId('listMembers');
  if (query.membershipIds?.length === 0) return { rows: [], total: 0 };
  const conditions: SQL[] = [eq(memberships.companyId, companyId)];
  if (query.search) {
    const pattern = containsPattern(query.search);
    conditions.push(
      sql`(${accounts.fullName} ilike ${pattern} escape '\\' or ${accounts.email} ilike ${pattern} escape '\\')`,
    );
  }
  if (query.status) conditions.push(eq(memberships.status, query.status === 'locked' ? 'suspended' : 'active'));
  if (query.membershipIds) conditions.push(inArray(memberships.id, [...query.membershipIds]));
  const where = and(...conditions);
  const db = getDb();
  // Tuần tự: hai câu cùng một kết nối giao dịch.
  const [counted] = await db
    .select({ total: count() })
    .from(memberships)
    .innerJoin(accounts, eq(accounts.id, memberships.accountId))
    .where(where);
  const rows = await db
    .select(memberColumns)
    .from(memberships)
    .innerJoin(accounts, eq(accounts.id, memberships.accountId))
    .where(where)
    .orderBy(accounts.fullName, memberships.id)
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  return { rows, total: counted?.total ?? 0 };
}

/** Tăng `version` của membership nếu khớp (đổi vai trò); `false` khi người khác vừa sửa. */
export async function bumpMembershipVersion(id: string, version: number): Promise<boolean> {
  const rows = await getDb()
    .update(memberships)
    .set({ version: sql`${memberships.version} + 1`, updatedAt: new Date() })
    .where(and(eq(memberships.id, id), eq(memberships.version, version)))
    .returning({ id: memberships.id });
  return rows.length === 1;
}

/** Khoá, mở khoá: chỉ ghi khi `version` khớp và đang ở `from`; `false` khi người khác vừa sửa. */
export async function updateMembershipStatus(
  id: string,
  version: number,
  from: 'active' | 'suspended',
  to: 'active' | 'suspended',
): Promise<boolean> {
  const rows = await getDb()
    .update(memberships)
    .set({ status: to, version: sql`${memberships.version} + 1`, updatedAt: new Date() })
    .where(and(eq(memberships.id, id), eq(memberships.version, version), eq(memberships.status, from)))
    .returning({ id: memberships.id });
  return rows.length === 1;
}
