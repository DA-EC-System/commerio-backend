// Tài khoản demo: CEO qua đăng ký thật; nhân viên qua hàm công khai staff/access như seed P1. Thêm hai công ty
// cho bộ test hộp đen (#120, `test/blackbox/`): A đủ năm vai trò có sẵn, B chỉ CEO để kiểm cô lập công ty.
// Không chạy luồng mời/OTP gửi email. Mọi tài khoản có sẵn phải đúng mật khẩu seed. Chạy lại nhiều lần không sinh trùng.
import { assignRole, BUILTIN_ROLES, rolesAndPermissions } from '#src/modules/core/access/index.ts';
import { hashPassword, register, verifyPassword } from '#src/modules/core/identity/index.ts';
import {
  createAccount,
  createMembership,
  findAccountByEmail,
  findMembership,
  membershipsOfAccount,
} from '#src/modules/core/staff/index.ts';
import type { OptionalModule } from '#src/modules/core/platform/index.ts';
import { inTransaction } from '#src/shared/db/client.ts';
import { AppError } from '#src/shared/errors/app-error.ts';
import { OPTIONAL_MODULES } from '#src/modules/core/index.ts';

type StaffRole = 'admin' | 'sale' | 'kho' | 'buyer';
const STAFF_ROLES: readonly StaffRole[] = ['admin', 'sale', 'kho', 'buyer'];
interface SeedAccount {
  email: string;
  fullName: string;
}

export interface SeedDemoInput {
  company: { name: string; taxCode: string };
  /** Phân hệ tuỳ chọn bật lúc đăng ký, mặc định mọi phân hệ; công ty đã có thì không đổi. */
  optionalModules?: OptionalModule[];
  password: string;
  accounts: { ceo: SeedAccount } & Partial<Record<StaffRole, SeedAccount>>;
  /** Thêm nhân viên cùng vai trò có sẵn với một tài khoản ở `accounts`. */
  extraStaff?: { role: StaffRole; account: SeedAccount }[];
}

/** Bộ dữ liệu dùng trên staging. Dữ liệu giả, không phải khách hàng thật. */
export function defaultDemo(password: string): SeedDemoInput {
  return {
    company: { name: 'Công ty Demo Commerio', taxCode: '0000000037' },
    password,
    accounts: {
      ceo: { email: 'ceo@commerio.dev', fullName: 'CEO Demo' },
      admin: { email: 'admin@commerio.dev', fullName: 'Admin Demo' },
      sale: { email: 'sale@commerio.dev', fullName: 'Sale Demo' },
      kho: { email: 'kho@commerio.dev', fullName: 'Kho Demo' },
      buyer: { email: 'mua@commerio.dev', fullName: 'Mua hàng Demo' },
    },
  };
}

/** Hai công ty của bộ test hộp đen (#120). Test ghi dữ liệu mới mỗi lần chạy vào đây, không đụng công ty demo. */
export function blackboxCompanies(password: string): SeedDemoInput[] {
  const account = (email: string, fullName: string) => ({ email: `${email}@commerio.dev`, fullName });
  return [
    {
      company: { name: 'Công ty QA Hộp Đen A', taxCode: '0300000120' },
      optionalModules: ['purchasing', 'channel', 'report'],
      password,
      accounts: {
        ceo: account('qa-ceo', 'QA Giám Đốc A'),
        admin: account('qa-admin', 'QA Quản Trị A'),
        sale: account('qa-sale', 'QA Bán Hàng A'),
        kho: account('qa-kho', 'QA Thủ Kho A'),
        buyer: account('qa-mua', 'QA Mua Hàng A'),
      },
      // Test gắn thêm vai trò tuỳ biến có cả quyền lập và duyệt đề nghị nhập (ca người thứ hai, không phải CEO).
      extraStaff: [{ role: 'buyer', account: account('qa-truong-mua', 'QA Trưởng Mua Hàng A') }],
    },
    {
      company: { name: 'Công ty QA Hộp Đen B', taxCode: '0300000121' },
      optionalModules: ['purchasing', 'channel', 'report'],
      password,
      accounts: { ceo: account('qa-ceo-b', 'QA Giám Đốc B') },
    },
  ];
}

/** Trùng khoá do hai lần seed chạy cùng lúc. Drizzle bọc lỗi pg: mã nằm ở `cause`. */
const isDuplicate = (err: unknown) =>
  (err instanceof AppError && err.code === 'email_taken') ||
  (err as { cause?: { code?: string } }).cause?.code === '23505';

/** Công ty demo: công ty duy nhất mà CEO seed giữ vai trò CEO. Tài khoản CEO của người khác (sai mật khẩu) thì dừng. */
export async function demoCompanyId(input: SeedDemoInput): Promise<string> {
  const { email } = input.accounts.ceo;
  let account = await findAccountByEmail(email);
  if (!account) {
    const modules = input.optionalModules ?? [...OPTIONAL_MODULES];
    try {
      return (
        await register({
          company: input.company,
          ceo: { ...input.accounts.ceo, password: input.password },
          optionalModules: modules,
          assistantDataConsent: modules.includes('assistant'),
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
async function ensureStaff(companyId: string, account: SeedAccount, role: StaffRole, passwordHash: string, password: string) {
  const { id: roleId, name: roleName } = BUILTIN_ROLES[role];
  await inTransaction(async () => {
    const existing = await findAccountByEmail(account.email);
    if (existing && !(await verifyPassword(existing.passwordHash, password))) {
      throw new Error(`${account.email} đã có nhưng sai mật khẩu seed; không thay đổi tài khoản`);
    }
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

export async function seedDemo(input: SeedDemoInput): Promise<{ companyId: string }> {
  const companyId = await demoCompanyId(input);
  // Băm một lần cho mọi nhân viên: argon2 chậm có chủ ý.
  const passwordHash = await hashPassword(input.password);
  const staff = [
    ...STAFF_ROLES.flatMap((role) => (input.accounts[role] ? [{ role, account: input.accounts[role] }] : [])),
    ...(input.extraStaff ?? []),
  ];
  for (const { role, account } of staff) {
    const ensure = () => ensureStaff(companyId, account, role, passwordHash, input.password);
    // Lần seed khác vừa tạo cùng tài khoản: giao dịch này đã rollback, chạy lại một lần sẽ thấy tài khoản đó.
    await ensure().catch((err: unknown) => (isDuplicate(err) ? ensure() : Promise.reject(err)));
  }
  return { companyId };
}
