// API công khai của module `staff`: tài khoản nhân viên, thư mời, công ty nhân viên làm việc, khoá tài khoản.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../shared/module.ts';

export const staffModule: ModuleDefinition = { name: 'staff' };
