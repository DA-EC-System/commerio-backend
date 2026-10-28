// API công khai của module lớn `insight` (Phân tích: báo cáo, trợ lý AI).
// Module lớn khác chỉ được import từ file này; module con trong cùng module lớn gọi nhau qua index.ts của module con.
import type { ModuleDefinition } from '../../shared/module.ts';
import { reportModule } from './report/index.ts';
import { assistantModule } from './assistant/index.ts';

export * from './report/index.ts';
export * from './assistant/index.ts';

/** Mỗi module con giữ tên, schema và đường dẫn /api/v1/<tên> riêng. */
export const insightModules: readonly ModuleDefinition[] = [reportModule, assistantModule];
