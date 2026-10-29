// API công khai của module `assistant`: trợ lý AI: tài liệu nội bộ, vector (pgvector).
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../../shared/module.ts';

export const assistantModule: ModuleDefinition = { name: 'assistant' };

/** Chặn tắt phân hệ Trợ lý AI khi đã có tài liệu (#152); `src/wiring.ts` đưa cho `platform`. */
export { hasAssistantData } from './repository/documents.ts';
