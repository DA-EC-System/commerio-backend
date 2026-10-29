// API công khai của module lớn `channel` (Kênh bán: sàn thương mại điện tử, hộp thư).
// Module lớn khác chỉ được import từ file này; module con trong cùng module lớn gọi nhau qua index.ts của module con.
import type { ModuleDefinition } from '../../shared/module.ts';
import { channelModule } from './channel/index.ts';
import { inboxModule } from './inbox/index.ts';

export * from './channel/index.ts';
export * from './inbox/index.ts';

/** Mỗi module con giữ tên, schema và đường dẫn /api/v1/<tên> riêng. */
export const channelModules: readonly ModuleDefinition[] = [channelModule, inboxModule];
