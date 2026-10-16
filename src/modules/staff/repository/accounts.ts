import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../../../shared/db/client.ts';
import { accounts, memberships } from './schema.ts';

export interface AccountRow {
  id: string;
  email: string;
  fullName: string;
  passwordHash: string | null;
  mustChangePassword: boolean;
  isPlatformAdmin: boolean;
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
};

export async function findAccountByEmail(email: string): Promise<AccountRow | undefined> {
  const [row] = await getDb().select(accountColumns).from(accounts).where(eq(accounts.email, email));
  return row;
}

export async function findAccountById(id: string): Promise<AccountRow | undefined> {
  const [row] = await getDb().select(accountColumns).from(accounts).where(eq(accounts.id, id));
  return row;
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

export async function findMembership(accountId: string, companyId: string): Promise<MembershipRow | undefined> {
  const [row] = await getDb()
    .select({ id: memberships.id, companyId: memberships.companyId, status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.accountId, accountId), eq(memberships.companyId, companyId)));
  return row;
}
