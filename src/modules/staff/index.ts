// API công khai của module `staff`: tài khoản, nhân viên, thư mời, khoá tài khoản theo công ty.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../shared/module.ts';

export const staffModule: ModuleDefinition = { name: 'staff' };

export type { AccountRow, MembershipRow } from './repository/accounts.ts';
export {
  findAccountByEmail,
  findAccountById,
  findMembership,
  insertAccount as createAccount,
  insertMembership as createMembership,
  membershipsOfAccount,
  updatePassword,
} from './repository/accounts.ts';
