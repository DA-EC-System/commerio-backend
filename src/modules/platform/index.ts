// API công khai của module `platform`: công ty, phân hệ đang bật, trạng thái khoá công ty.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../shared/module.ts';

export const platformModule: ModuleDefinition = { name: 'platform' };
