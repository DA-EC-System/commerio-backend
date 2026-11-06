import { and, eq, gt, isNull } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { refreshTokens } from './schema.ts';

export interface RefreshTokenRow {
  id: string;
  accountId: string;
  companyId: string | null;
}

export interface LockedRefreshToken extends RefreshTokenRow {
  familyId: string;
  rotatedAt: Date | null;
}

/** Không truyền `familyId` thì mở họ mới (đăng nhập). */
export async function insertRefreshToken(input: {
  accountId: string;
  companyId: string | null;
  familyId?: string;
  tokenHash: string;
  expiresAt: Date;
}): Promise<void> {
  await getDb().insert(refreshTokens).values(input);
}

/** Token hiện hành của phiên: còn hạn, chưa thu hồi, chưa bị xoay vòng. */
export async function findActiveRefreshToken(tokenHash: string): Promise<RefreshTokenRow | undefined> {
  const [row] = await getDb()
    .select({ id: refreshTokens.id, accountId: refreshTokens.accountId, companyId: refreshTokens.companyId })
    .from(refreshTokens)
    .where(
      and(
        eq(refreshTokens.tokenHash, tokenHash),
        isNull(refreshTokens.revokedAt),
        isNull(refreshTokens.rotatedAt),
        gt(refreshTokens.expiresAt, new Date()),
      ),
    );
  return row;
}

/**
 * Khoá dòng token còn hạn, chưa thu hồi hẳn (có thể đã xoay vòng); gọi trong transaction. Hai refresh cùng cookie
 * xếp hàng ở đây, request sau thấy `rotatedAt` của request trước.
 */
export async function lockUsableRefreshToken(tokenHash: string): Promise<LockedRefreshToken | undefined> {
  const [row] = await getDb()
    .select({
      id: refreshTokens.id,
      accountId: refreshTokens.accountId,
      companyId: refreshTokens.companyId,
      familyId: refreshTokens.familyId,
      rotatedAt: refreshTokens.rotatedAt,
    })
    .from(refreshTokens)
    .where(
      and(
        eq(refreshTokens.tokenHash, tokenHash),
        isNull(refreshTokens.revokedAt),
        gt(refreshTokens.expiresAt, new Date()),
      ),
    )
    .for('update');
  return row;
}

/** Đánh dấu token đã được thay bằng token kế tiếp. */
export async function markRefreshTokenRotated(id: string): Promise<void> {
  await getDb().update(refreshTokens).set({ rotatedAt: new Date() }).where(eq(refreshTokens.id, id));
}

/** Thu hồi hẳn cả họ token (đăng xuất, phát hiện dùng lại): token kế tiếp và token trong hạn dùng lại cũng chết. */
export async function revokeRefreshFamily(familyId: string): Promise<void> {
  await getDb()
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
}

/** Thu hồi mọi refresh token còn hiệu lực của tài khoản (đổi mật khẩu). */
export async function revokeAllRefreshTokens(accountId: string): Promise<void> {
  await getDb()
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.accountId, accountId), isNull(refreshTokens.revokedAt)));
}

export async function setRefreshTokenCompany(id: string, companyId: string): Promise<void> {
  await getDb().update(refreshTokens).set({ companyId }).where(eq(refreshTokens.id, id));
}
