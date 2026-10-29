// API công khai của module `staff`: tài khoản, nhân viên, thư mời, khoá tài khoản theo công ty.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../../shared/module.ts';
import { registerStaffOpenApi } from './api/openapi.ts';
import { staffRouter } from './api/routes.ts';
import { startStaffBackground } from './service/background.ts';

export const staffModule: ModuleDefinition = { name: 'staff', startBackground: startStaffBackground };

// Không gắn tại /api/v1/staff: identity gắn router này dưới /api/v1/identity (/identity/staff, Documents/21 I1).
export { registerStaffOpenApi, staffRouter };

export type { AccountRow, MembershipRow } from './repository/accounts.ts';
// Nền vòng đời (#101): tự duyệt, `statusHistory` kèm tên người (Documents/21 mục 14.1).
export { canSelfApprove, getStatusHistory, type StatusChange } from './service/lifecycle.ts';
export {
  findAccountByEmail,
  findAccountByGoogleSub,
  findAccountById,
  findAccountSummaries,
  findMembership,
  insertAccount as createAccount,
  insertMembership as createMembership,
  linkGoogleSub,
  membershipsOfAccount,
  updatePassword,
} from './repository/accounts.ts';
