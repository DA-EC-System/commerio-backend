// Cấp, gỡ quyền quản trị nền tảng (#152, UC-PI-08). Quản trị nền tảng không thuộc công ty nào (đăng nhập trả
// `memberships: []`), nên không bật cờ cho tài khoản đang là thành viên: tạo tài khoản riêng.
import {
  createAccount,
  findAccountByEmail,
  hashPassword,
  membershipsOfAccount,
  setPlatformAdmin,
} from '#src/modules/core/index.ts';
import { newPasswordSchema } from '#src/shared/auth/password-policy.ts';
import { inTransaction } from '#src/shared/db/client.ts';

/** Có tài khoản thì bật cờ (cần `password` chỉ khi phải tạo mới). Trả việc đã làm để in ra. */
export async function grantPlatformAdmin(input: {
  email: string;
  fullName?: string | undefined;
  password?: string | undefined;
}): Promise<'created' | 'granted' | 'unchanged'> {
  const email = input.email.trim().toLowerCase();
  if (input.password !== undefined) {
    const checked = newPasswordSchema.safeParse(input.password);
    if (!checked.success) throw new Error(checked.error.issues[0]!.message);
  }
  const passwordHash = input.password ? await hashPassword(input.password) : null;
  return inTransaction(async () => {
    const account = await findAccountByEmail(email);
    if (!account) {
      if (!passwordHash) throw new Error('Tài khoản chưa có: cần PLATFORM_ADMIN_PASSWORD để tạo');
      const id = await createAccount({ email, fullName: input.fullName ?? 'Quản trị nền tảng', passwordHash });
      await setPlatformAdmin(id, true);
      return 'created';
    }
    if (account.isPlatformAdmin) return 'unchanged';
    if ((await membershipsOfAccount(account.id)).length > 0) {
      throw new Error('Tài khoản đang thuộc một công ty; quản trị nền tảng phải là tài khoản riêng');
    }
    await setPlatformAdmin(account.id, true);
    return 'granted';
  });
}

export async function revokePlatformAdmin(email: string): Promise<'revoked' | 'unchanged'> {
  return inTransaction(async () => {
    const account = await findAccountByEmail(email.trim().toLowerCase());
    if (!account) throw new Error('Không có tài khoản này');
    if (!account.isPlatformAdmin) return 'unchanged';
    await setPlatformAdmin(account.id, false);
    return 'revoked';
  });
}
