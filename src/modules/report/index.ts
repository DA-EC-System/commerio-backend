// API công khai của module `report`: bảng số liệu dựng từ sự kiện.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../shared/module.ts';

export const reportModule: ModuleDefinition = { name: 'report' };
