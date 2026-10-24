// Dữ liệu demo P1 (#37, Documents/21 V37, D12): một công ty, bốn tài khoản theo bốn vai trò có sẵn.
// CEO đi qua đăng ký thật (argon2, nhật ký); nhân viên tạo bằng hàm công khai của staff/access vì luồng mời
// (#7) cần người nhận thư OTP, nên không có nhật ký thao tác. Có `totpSecret` thì cả bốn tài khoản bật 2FA bằng secret
// đó (#7 [D]), để demo đăng nhập được khi `TWO_FACTOR_MODE=required`. Chạy lại nhiều lần không sinh trùng.
import { assignRole, BUILTIN_ROLES, rolesAndPermissions } from '#src/modules/access/index.ts';
import { hashPassword, register, verifyPassword } from '#src/modules/identity/index.ts';
import {
  createAccount,
  createMembership,
  enableTotp,
  findAccountByEmail,
  findMembership,
  membershipsOfAccount,
  saveTotpSecret,
  sealTotpSecret,
} from '#src/modules/staff/index.ts';
import { base32Decode } from '#src/shared/crypto/totp.ts';
import { inTransaction } from '#src/shared/db/client.ts';
import { AppError } from '#src/shared/errors/app-error.ts';

type StaffRole = 'admin' | 'sale' | 'kho';
interface SeedAccount {
  email: string;
  fullName: string;
}

export interface SeedDemoInput {
  company: { name: string; taxCode: string };
  password: string;
  accounts: { ceo: SeedAccount } & Record<StaffRole, SeedAccount>;
  /** Secret TOTP base32 chung của tài khoản demo (`DEMO_TOTP_SECRET`, dữ liệu giả, công khai). */
  totpSecret?: string;
}

/** Bộ dữ liệu dùng trên staging. Dữ liệu giả, không phải khách hàng thật. */
export function defaultDemo(password: string, totpSecret?: string): SeedDemoInput {
  return {
    company: { name: 'Công ty Demo Commerio', taxCode: '0300000037' },
    password,
    ...(totpSecret ? { totpSecret } : {}),
    accounts: {
      ceo: { email: 'ceo@commerio.dev', fullName: 'Nguyễn Văn Giám Đốc' },
      admin: { email: 'admin@commerio.dev', fullName: 'Trần Thị Quản Trị' },
      sale: { email: 'sale@commerio.dev', fullName: 'Lê Văn Bán Hàng' },
      kho: { email: 'kho@commerio.dev', fullName: 'Phạm Thị Thủ Kho' },
    },
  };
}

/** Trùng khoá do hai lần seed chạy cùng lúc. Drizzle bọc lỗi pg: mã nằm ở `cause`. */
const isDuplicate = (err: unknown) =>
  (err instanceof AppError && err.code === 'email_taken') ||
  (err as { cause?: { code?: string } }).cause?.code === '23505';

/** Công ty demo: công ty duy nhất mà CEO seed giữ vai trò CEO. Tài khoản CEO của người khác (sai mật khẩu) thì dừng. */
async function demoCompanyId(input: SeedDemoInput): Promise<string> {
  const { email } = input.accounts.ceo;
  let account = await findAccountByEmail(email);
  if (!account) {
    try {
      return (
        await register({
          company: input.company,
          ceo: { ...input.accounts.ceo, password: input.password },
          optionalModules: [],
          assistantDataConsent: false,
        })
      ).companyId;
    } catch (err) {
      // Hai lần seed chạy cùng lúc: lần thua đọc lại tài khoản lần thắng vừa tạo.
      if (!isDuplicate(err)) throw err;
      account = await findAccountByEmail(email);
      if (!account) throw err;
    }
  }
  if (!(await verifyPassword(account.passwordHash, input.password))) {
    throw new Error(`${email} đã có nhưng không phải tài khoản seed (sai mật khẩu seed); không seed vào công ty của người khác`);
  }
  const memberships = await membershipsOfAccount(account.id);
  const roles = await rolesAndPermissions(memberships.map((m) => m.id));
  const asCeo = memberships.filter((m) => roles.get(m.id)?.roles.includes(BUILTIN_ROLES.ceo.name));
  if (asCeo.length !== 1) throw new Error(`${email} phải là CEO của đúng một công ty, đang là CEO của ${asCeo.length}`);
  return asCeo[0]!.companyId;
}

/** Nhân viên trong công ty demo: thiếu tài khoản, membership hay vai trò thì bù; tài khoản thuộc công ty khác thì dừng. */
async function ensureStaff(companyId: string, account: SeedAccount, role: StaffRole, passwordHash: string) {
  const { id: roleId, name: roleName } = BUILTIN_ROLES[role];
  await inTransaction(async () => {
    const existing = await findAccountByEmail(account.email);
    if (existing && (await membershipsOfAccount(existing.id)).some((m) => m.companyId !== companyId)) {
      throw new Error(`${account.email} đã thuộc công ty khác; không dùng làm tài khoản seed`);
    }
    const accountId = existing?.id ?? (await createAccount({ ...account, passwordHash }));
    const membershipId =
      (await findMembership(accountId, companyId))?.id ?? (await createMembership(companyId, accountId));
    const roles = (await rolesAndPermissions([membershipId])).get(membershipId)?.roles ?? [];
    if (!roles.includes(roleName)) await assignRole({ membershipId, roleId, companyId });
  });
}

/** Bật 2FA bằng secret demo nếu chưa bật; đã bật (kể cả người dùng tự thiết lập lại) thì giữ nguyên. */
async function ensureTotp(email: string, secret: Buffer) {
  const account = await findAccountByEmail(email);
  if (!account || account.totpEnabledAt) return;
  await inTransaction(async () => {
    await saveTotpSecret(account.id, sealTotpSecret(secret, account.id));
    await enableTotp(account.id, 0, []);
  });
}

export async function seedDemo(input: SeedDemoInput): Promise<{ companyId: string }> {
  const companyId = await demoCompanyId(input);
  // Băm một lần cho ba nhân viên: argon2 chậm có chủ ý.
  const passwordHash = await hashPassword(input.password);
  for (const role of ['admin', 'sale', 'kho'] as const) {
    const ensure = () => ensureStaff(companyId, input.accounts[role], role, passwordHash);
    // Lần seed khác vừa tạo cùng tài khoản: giao dịch này đã rollback, chạy lại một lần sẽ thấy tài khoản đó.
    await ensure().catch((err: unknown) => (isDuplicate(err) ? ensure() : Promise.reject(err)));
  }
  if (input.totpSecret) {
    const secret = base32Decode(input.totpSecret);
    for (const { email } of Object.values(input.accounts)) await ensureTotp(email, secret);
  }
  return { companyId };
}
