import { hashPassword } from '#src/shared/crypto/password.ts';
import { uniqueEmail } from '../helpers/company.ts';
import { testPool } from '../helpers/db.ts';
import { PASSWORD } from '../helpers/http.ts';

export async function accountIdOf(email: string): Promise<string> {
  const res = await testPool().query<{ id: string }>('select id from staff.accounts where email = $1', [email]);
  return res.rows[0]!.id;
}

/**
 * Lời mời đã nộp (`pending`) chèn thẳng bằng role chủ bảng, như sau `/join/complete`. Có `existingAccountId` thì là
 * tài khoản đã có (`sign_in`); không thì là email mới (`set_password`) với mật khẩu `PASSWORD`.
 */
export async function pendingInvitation(
  companyId: string,
  options: { createdBy: string; roleIds: string[]; email?: string; existingAccountId?: string },
): Promise<{ id: string; version: number; email: string }> {
  const email = options.email ?? uniqueEmail('moi');
  const passwordHash = options.existingAccountId ? null : await hashPassword(PASSWORD);
  const res = await testPool().query<{ id: string; version: number }>(
    `insert into staff.invitations
       (company_id, role_ids, created_by, expires_at, status, email, full_name, submitted_at, password_hash, account_id)
     values ($1, $2, $3, now() + interval '72 hours', 'pending', $4, 'Nhân Viên Mới', now(), $5, $6)
     returning id, version`,
    [companyId, options.roleIds, options.createdBy, email, passwordHash, options.existingAccountId ?? null],
  );
  return { id: res.rows[0]!.id, version: res.rows[0]!.version, email };
}
