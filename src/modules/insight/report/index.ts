// API công khai của module `report`: đọc bảng số liệu dựng sẵn (Documents/21 D18). Phần tính lại từ chứng từ cũ đã gỡ ở #235.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../../shared/module.ts';
import { registerReportOpenApi } from './api/openapi.ts';
import { reportRouter } from './api/routes.ts';

export const reportModule: ModuleDefinition = {
  name: 'report',
  router: reportRouter,
  openapi: registerReportOpenApi,
};

/** Xoá gian hàng đã ngắt (#398): channel gọi qua `ctx.deleteShopSummaries` (`src/wiring.ts`, insight đã import channel). */
export { deleteShopSummaries } from './repository/summary.ts';
