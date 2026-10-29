// API công khai của module `inbox`: hội thoại, tin nhắn, nhãn, ghi chú.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../../shared/module.ts';

export const inboxModule: ModuleDefinition = { name: 'inbox' };

/** Chặn tắt phân hệ Hộp thư khi đã có dữ liệu (#152); `src/wiring.ts` đưa cho `platform`. */
export { hasInboxData } from './repository/conversations.ts';
