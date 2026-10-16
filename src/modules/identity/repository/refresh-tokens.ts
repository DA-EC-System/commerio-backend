import { and, eq, gt, isNull } from 'drizzle-orm';
import { getDb } from '../../../shared/db/client.ts';
import { refreshTokens } from './schema.ts';

export interface RefreshTokenRow {
  id: string;
  accountId: string;
  companyId: string | null;
}

export async function insertRefreshToken(input: {
  accountId: string;
  companyId: string | null;
  tokenHash: string;
  expiresAt: Date;
}): Promise<void> {
  await getDb().insert(refreshTokens).values(input);
}

/** Token còn hạn, chưa thu hồi. */
export async function findActiveRefreshToken(tokenHash: string): Promise<RefreshTokenRow | undefined> {
  const [row] = await getDb()
    .select({ id: refreshTokens.id, accountId: refreshTokens.accountId, companyId: refreshTokens.companyId })
    .from(refreshTokens)
    .where(
      and(
        eq(refreshTokens.tokenHash, tokenHash),
        isNull(refreshTokens.revokedAt),
        gt(refreshTokens.expiresAt, new Date()),
      ),
    );
  return row;
}

/** Thu hồi; trả false nếu token đã bị thu hồi trước đó (hai request refresh cùng lúc). */
export async function revokeRefreshToken(id: string): Promise<boolean> {
  const rows = await getDb()
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.id, id), isNull(refreshTokens.revokedAt)))
    .returning({ id: refreshTokens.id });
  return rows.length > 0;
}

export async function setRefreshTokenCompany(id: string, companyId: string): Promise<void> {
  await getDb().update(refreshTokens).set({ companyId }).where(eq(refreshTokens.id, id));
}
