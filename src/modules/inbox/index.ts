// API công khai của module `inbox`: hội thoại, tin nhắn, nhãn, ghi chú.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../shared/module.ts';

export const inboxModule: ModuleDefinition = { name: 'inbox' };
