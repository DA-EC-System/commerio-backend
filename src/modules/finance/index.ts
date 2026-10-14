// API công khai của module `finance`: hoá đơn, phiếu thu, phiếu chi, khoản thu chưa khớp, đối soát.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../shared/module.ts';

export const financeModule: ModuleDefinition = { name: 'finance' };
