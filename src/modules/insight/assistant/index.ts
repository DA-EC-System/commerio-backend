// API công khai của module `assistant`: trợ lý AI: tài liệu nội bộ, vector (pgvector).
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../../shared/module.ts';

export const assistantModule: ModuleDefinition = { name: 'assistant' };
