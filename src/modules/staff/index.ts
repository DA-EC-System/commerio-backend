// API công khai của module `staff`: tài khoản, nhân viên, thư mời, khoá tài khoản theo công ty.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../shared/module.ts';
import { registerStaffOpenApi } from './api/openapi.ts';
import { staffRouter } from './api/routes.ts';
import { startStaffBackground } from './service/background.ts';

export const staffModule: ModuleDefinition = { name: 'staff', startBackground: startStaffBackground };

// Không gắn tại /api/v1/staff: identity gắn router này dưới /api/v1/identity (/identity/staff, Documents/21 I1).
export { registerStaffOpenApi, staffRouter };

export type { AccountRow, MembershipRow } from './repository/accounts.ts';
export {
  advanceTotpStep,
  clearTotp,
  consumeRecoveryCode,
  enableTotp,
  findAccountByEmail,
  findAccountByGoogleSub,
  findAccountById,
  findMembership,
  insertAccount as createAccount,
  insertMembership as createMembership,
  isPlatformAdmin,
  linkGoogleSub,
  membershipsOfAccount,
  saveTotpSecret,
  updatePassword,
} from './repository/accounts.ts';

// Secret TOTP và mã khôi phục (#7 [D]): identity dùng khi thiết lập 2FA và ở bước nhập mã.
export {
  hashRecoveryCode,
  newRecoveryCodes,
  newTotpSetup,
  openTotpSecret,
  RECOVERY_CODE_COUNT,
  sealTotpSecret,
} from './service/totp-secrets.ts';
