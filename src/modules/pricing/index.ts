// API công khai của module `pricing`: bảng giá chuẩn, giá theo kênh.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../shared/module.ts';

export const pricingModule: ModuleDefinition = { name: 'pricing' };
