import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../../shared/db/client.ts';
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
 * `commerio_app` không được UPDATE `staff.accounts`). `sub` đã gắn tài khoản khác thì ném 23505
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
