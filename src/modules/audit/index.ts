// API công khai của module `audit`: nhật ký thao tác.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../shared/module.ts';

export const auditModule: ModuleDefinition = { name: 'audit' };
