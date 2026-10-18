// API công khai của module `notification`: đẩy thông báo qua tiến trình realtime. Không có bảng.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../shared/module.ts';
import { registerNotificationOpenApi } from './api/openapi.ts';

export const notificationModule: ModuleDefinition = { name: 'notification', openapi: registerNotificationOpenApi };
